// api/recommands.js
import Airtable from 'airtable';
import OpenAI from 'openai';

// Debug logs pour vérifier les variables d'environnement
console.log("🔎 • BaseID :", process.env.AIRTABLE_BASE_ID);
console.log("🔑 • Airtable Token loaded ?", !!process.env.AIRTABLE_TOKEN_ID);
console.log("🔑 • OpenAI Key loaded ?", !!process.env.OPENAI_API_KEY);

// Initialisation d'Airtable avec le Personal Access Token
const base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN_ID })
  .base(process.env.AIRTABLE_BASE_ID);

// Instanciation du client OpenAI (v4)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  console.log('→ handler called');
  try {
    // 1) Nom exact de la table Airtable
    const tableName = 'Recommandations';
    console.log("📋 • Je tente d’interroger la table :", tableName);

    // 2) Récupération brute des enregistrements
    const records = await base(tableName).select().firstPage();

    // ───── NOUVEAU ─────
    // 2.a) Récupère tous les IDs de quartier cités
    const allQuartierIds = new Set();
    records.forEach(r => {
      const q = r.fields.quartier;
      if (Array.isArray(q)) q.forEach(id => allQuartierIds.add(id));
    });

    // 2.b) Charge les enregistrements "Quartiers" correspondants
    let quartierMap = {};
    if (allQuartierIds.size) {
      const formula = `OR(${[...allQuartierIds]
        .map(id => `RECORD_ID()="${id}"`)
        .join(',')})`;

      const quartiers = await base('Quartiers')
        .select({ filterByFormula: formula })
        .firstPage();

      quartiers.forEach(q => {
        // adapte "Name" au nom exact de ton champ dans la table Quartiers
        quartierMap[q.id] = q.fields["Neighborhoods Name"];
      });
    }
    console.log('🔑 • Quartier mapping:', quartierMap);
    // ──────────────────────

    console.log("✅ • Nombre de recs Airtable :", records.length);

   // ─── 3) Filtrer et mapper avec les bons noms de champs ────────────
const validRecords = records.filter(r => {
  const f = r.fields;
  // on vérifie la présence de 'nom' et 'Adresse'
  return !!f.nom && !!f.Adresse;
});

const spots = validRecords.map(r => {
  const f = r.fields;
  return {
    name:        f.nom,                                 // champ "nom"
    type:        f.type,                                // champ "type"
    theme:       f.thème,                               // champ "thème"
    category:    f.Catégorie,                           // champ "Catégorie"
    quartier:    Array.isArray(f.Quartier)              // champ "Quartier" (IDs)
                     ? f.Quartier.map(id => quartierMap[id] || id)
                     : [],
    address:     f.Adresse,                            // champ "Adresse"
    togo:        f["Lien Google Maps"],                // champ "Lien Google Maps"
    description: f.Description                          // champ "Description"
  };
});

console.log('→ spots enrichis :', spots);

    // 4) Construction du prompt pour OpenAI
    const prompt = `Vous êtes Julie, concierge virtuelle.
Voici la liste des spots disponibles (JSON) :
${JSON.stringify(spots, null, 2)}

Propose à l’utilisateur 3 spots adaptés, avec une petite description chaleureuse.`;

    // 5) Appel à l'API OpenAI ChatCompletion
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Vous êtes Julie, une concierge virtuelle, chaleureuse et décontractée.' },
        { role: 'user',   content: prompt }
      ],
      max_tokens: 100,
    });
    console.log('→ OpenAI response:', completion);

    // 6) Extraction de la réponse et renvoi au front
    const answer = completion.choices[0].message.content;
    return res.status(200).json({ message: answer });

  } catch (err) {
    console.error('🔥 OpenAI or Airtable error:', err.response?.data || err);
    return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
}