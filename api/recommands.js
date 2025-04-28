// api/recommands.js
import Airtable from 'airtable';
import OpenAI from 'openai';

// Debug logs pour vérifier les variables d'environnement
console.log("🔎 • BaseID :", process.env.AIRTABLE_BASE_ID);
console.log("🔑 • Airtable Token loaded ?", !!process.env.AIRTABLE_TOKEN_ID);
console.log("🔑 • OpenAI Key loaded ?", !!process.env.OPENAI_API_KEY);

// Initialisation d'Airtable
const base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN_ID })
  .base(process.env.AIRTABLE_BASE_ID);

// Instanciation du client OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  console.log('→ handler called');
  try {
    // On récupère la question de l’utilisateur
    const userQuery = (req.body.query || '').trim();
    console.log('🗣️  Question utilisateur :', userQuery);

    // 1) Lecture de la table
    const records = await base('Recommandations').select().firstPage();

    // 2) Récupération des quartiers liés
    const allQuartierIds = new Set();
    records.forEach(r => {
      const q = r.fields.Quartier;
      if (Array.isArray(q)) q.forEach(id => allQuartierIds.add(id));
    });
    const quartierMap = {};
    if (allQuartierIds.size) {
      const formula = `OR(${[...allQuartierIds]
        .map(id => `RECORD_ID()="${id}"`)
        .join(',')})`;
      const quartiers = await base('Quartiers')
        .select({ filterByFormula: formula })
        .firstPage();
      quartiers.forEach(q => {
        quartierMap[q.id] = q.fields["Neighborhoods Name"];
      });
    }

    // 3) Filtrage et mapping
    const spots = records
      .filter(r => r.fields.nom && r.fields.Adresse)
      .map(r => ({
        name:        r.fields.nom,
        type:        r.fields.type,
        theme:       r.fields.thème,
        category:    r.fields.Catégorie,
        quartier:    Array.isArray(r.fields.Quartier)
                       ? r.fields.Quartier.map(id => quartierMap[id] || id)
                       : [],
        address:     r.fields.Adresse,
        togo:        r.fields["Lien Google Maps"],
        description: r.fields.Description
      }));

    console.log('→ spots disponibles :', spots.length);

    // 4) Construction du prompt en intégrant la question
    const prompt = `
Vous êtes Julie, une concierge virtuelle, chaleureuse et décontractée.

L’utilisateur a demandé : "${userQuery}"

Voici la liste des spots disponibles (JSON) :
${JSON.stringify(spots, null, 2)}

En fonction de sa demande, propose-lui 3 spots adaptés, avec une description personnalisée pour chacun.
`;

    // 5) Appel à l’API OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Tu es Julie, concierge virtuelle.' },
        { role: 'user',   content: prompt }
      ],
      max_tokens: 300
    });
    const answer = completion.choices[0].message.content;

    // 6) Renvoi
    res.status(200).json({ message: answer });

  } catch (err) {
    console.error('🔥 Erreur dans /api/recommands :', err);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
}