// api/recommands.js
import Airtable from 'airtable';
import OpenAI from 'openai';

const base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN_ID })
  .base(process.env.AIRTABLE_BASE_ID);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  const { query, context = {} } = req.body;

  // 1️⃣ Si on n'a pas encore l'ambiance souhaitée, on pose la question
  if (!context.ambiance) {
    return res.status(200).json({
      message: "Pour personnaliser mes suggestions : quelle ambiance préférez-vous ? (cosy, dynamique, romantique…)",
      needClarification: true
    });
  }

  // 2️⃣ Quand on a l'ambiance, on poursuit la logique existante
  try {
    // … chargement Airtable (inchangé) …
    const records = await base('Recommandations').select().firstPage();
    // construction de votre tableau spots…
    const spots = records
      .filter(r => r.fields.nom && r.fields.Adresse)
      .map(/* mapping inchangé */);

    // 3️⃣ On peut aussi filtrer par ambiance si vous avez un champ `theme`
    const filtered = spots.filter(s => s.theme?.includes(context.ambiance));

    // 4️⃣ Prompt construit en injectant le contexte
    const systemPrompt = `Vous êtes Julie, concierge virtuelle, chaleureuse et décontractée.`;
    const userPrompt = `
L’utilisateur a demandé : "${query}"
Il/elle recherche une ambiance : ${context.ambiance}

Voici les spots disponibles (JSON) :
${JSON.stringify(filtered.length ? filtered : spots, null, 2)}

Proposez-lui 3 suggestions personnalisées, avec une petite description et un lien Google Maps.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt }
      ],
      max_tokens: 300
    });

    const answer = completion.choices[0].message.content;
    return res.status(200).json({ message: answer });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}