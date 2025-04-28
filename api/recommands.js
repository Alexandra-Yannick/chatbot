// api/recommands.js
import Airtable from 'airtable';
import OpenAI from 'openai';

// --- DEBUG ---
console.log("🔎 • BaseID :", process.env.AIRTABLE_BASE_ID);
console.log("🔑 • Airtable Token loaded ?", !!process.env.AIRTABLE_TOKEN_ID);
console.log("🔑 • OpenAI Key loaded ?", !!process.env.OPENAI_API_KEY);

// Initialise Airtable
const base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN_ID })
  .base(process.env.AIRTABLE_BASE_ID);

// Instancie le client OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  console.log('→ handler called');

  // 1) Vérifie qu’on a bien reçu la question
  const userQuery = req.body.query?.trim();
  if (!userQuery) {
    return res.status(400).json({ error: "Il faut fournir `query` dans le body." });
  }

  try {
    // 2) Charge les spots depuis Airtable
    const records = await base('Recommandations').select().firstPage();

    // 2.a) map des Quartiers liés...
    const allQuartierIds = new Set();
    records.forEach(r => {
      const q = r.fields.Quartier;
      if (Array.isArray(q)) q.forEach(id => allQuartierIds.add(id));
    });
    let quartierMap = {};
    if (allQuartierIds.size) {
      const formula = `OR(${[...allQuartierIds]
        .map(id => `RECORD_ID()="${id}"`)
        .join(',')})`;
      const quartiers = await base('Neighborhoods')
        .select({ filterByFormula: formula })
        .firstPage();
      quartiers.forEach(q => {
        quartierMap[q.id] = q.fields["Neighborhoods Name"];
      });
    }

    // 3) Filtre / map des champs
    const spots = records
      .filter(r => r.fields.nom && r.fields.Adresse)
      .map(r => {
        const f = r.fields;
        return {
          name:        f.nom,
          type:        f.type,
          theme:       f.thème,
          category:    f.Catégorie,
          quartier:    Array.isArray(f.Quartier)
                         ? f.Quartier.map(id => quartierMap[id]||id)
                         : [],
          address:     f.Adresse,
          togo:        f["Lien Google Maps"],
          description: f.Description
        };
      });

    // 4) Construction des messages pour OpenAI
    const systemPrompt = `Vous êtes Julie, une concierge virtuelle, chaleureuse et décontractée.
Vous allez proposer des lieux adaptés à la demande de l’utilisateur.`;
    const userPrompt = `
L’utilisateur a demandé : "${userQuery}"

Voici la liste des spots disponibles (JSON) :
${JSON.stringify(spots, null, 2)}

En fonction de sa demande, proposez-lui 3 suggestions personnalisées, avec une petite description pour chacune.`;

    // 5) Choix du modèle (fallback si pas accès à GPT-4)
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    let completion;
    try {
      completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system",  content: systemPrompt },
          { role: "user",    content: userPrompt }
        ],
        max_tokens: 300
      });
    } catch (err) {
      if (err.response?.status === 403) {
        // réessaye en gpt-3.5-turbo
        console.warn("Pas d’accès à", model, "– fallback sur gpt-3.5-turbo");
        completion = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: userPrompt }
          ],
          max_tokens: 300
        });
      } else {
        throw err;
      }
    }

    // 6) On renvoie
    const answer = completion.choices[0].message.content;
    return res.status(200).json({ message: answer });

  } catch (err) {
    console.error('🔥 Erreur handler /api/recommands:', err);
    const msg = err.response?.data?.error?.message || err.message;
    return res.status(500).json({ error: msg });
  }
}