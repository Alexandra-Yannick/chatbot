// scrap-instagram-simple.js
import Airtable from 'airtable';
import fetch from 'node-fetch';
import 'dotenv/config';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, IG_SESSIONID, IG_CSRFTOKEN } = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !process.env.OPENAI_API_KEY || !IG_SESSIONID || !IG_CSRFTOKEN) {
  console.error('⚠️ Définis AIRTABLE_API_KEY, AIRTABLE_BASE_ID, OPENAI_API_KEY, IG_SESSIONID et IG_CSRFTOKEN dans .env');
  process.exit(1);
}

// Configure Airtable
Airtable.configure({ apiKey: AIRTABLE_API_KEY });
const base = new Airtable().base(AIRTABLE_BASE_ID);

const POSTS_LIMIT = 5;

// 1) Récupère la liste des influenceurs depuis Airtable
async function getInfluencers() {
  const recs = await base('Influencers').select({
    view: 'Grid view',
    fields: ['Account']
  }).all();
  return recs.map(r => r.get('Account')).filter(Boolean);
}

// 2) Vérifie l'existence d'un post dans la table Posts
async function recordExists(postId) {
  const recs = await base('Posts')
    .select({ filterByFormula: `{ID post} = "${postId}"`, maxRecords: 1 })
    .firstPage();
  return recs.length > 0;
}

// 3) Appelle OpenAI pour décider et résumer
async function vetAndSummarizePost(post) {
  const prompt = `
Tu es Julie, concierge virtuelle experte en bons plans bordelais.
Garde uniquement les posts parlant d'un lieu ou événement local à Bordeaux.
Autres contenus : discard.
Post (JSON) :
\`\`\`json
${JSON.stringify(post, null, 2)}
\`\`\`
Réponds strictement JSON :
{"decision":"keep"|"discard","summary":"…"}
`;
  const resp = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    temperature: 0.7,
    max_tokens: 150,
    messages: [
      { role: 'system',  content: 'Tu es Julie, concierge virtuelle.' },
      { role: 'user',    content: prompt }
    ]
  });
  try {
    return JSON.parse(resp.choices[0].message.content);
  } catch {
    console.warn('⚠️ IA a renvoyé du JSON invalide:', resp.choices[0].message.content);
    return { decision: 'discard', summary: '' };
  }
}

// 4) Récupère le profil via l’API iOS Instagram
async function fetchProfile(username) {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':  'Instagram 155.0.0.37.107 (iPhone13,4; iOS 14.0; Scale/3.00)',
      'x-ig-app-id': '936619743392459',
      'cookie':      `sessionid=${IG_SESSIONID}; csrftoken=${IG_CSRFTOKEN};`
    }
  });
  console.log(`→ [fetchProfile] ${username} → HTTP ${res.status}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const json = JSON.parse(text);
  const user = json.data?.user;
  if (!user) throw new Error(`User JSON absent pour ${username}`);
  return user;
}

// 5) Sauvegarde un post dans Airtable
async function savePost(fields) {
  await base('Posts').create([{ fields }]);
}

// 6) Boucle principale
async function sync() {
  console.log('🚀 Démarrage scraping Instagram…');
  const influencers = await getInfluencers();

  for (const username of influencers) {
    console.log(`↪️  Scraping @${username}`);
    let user;
    try {
      user = await fetchProfile(username);
    } catch (err) {
      console.warn(`   ⚠️ Erreur fetch @${username}:`, err.message);
      continue;
    }

    const edges = user.edge_owner_to_timeline_media?.edges || [];
    for (const edge of edges.slice(0, POSTS_LIMIT)) {
      const node = edge.node;
      const post = {
        id:           node.id,
        caption:      node.edge_media_to_caption.edges[0]?.node?.text || '',
        permalink:    `https://www.instagram.com/p/${node.shortcode}/`,
        timestamp:    new Date(node.taken_at_timestamp * 1000).toISOString(),
        interactions: node.edge_liked_by.count + node.edge_media_to_comment.count
      };

      // Skip si déjà importé
      if (await recordExists(post.id)) {
        console.log(`   - Post ${post.id} déjà existant`);
        continue;
      }

      // Analyse IA
      console.log(`   ↪️  IA analyse post ${post.id}…`);
      const { decision, summary } = await vetAndSummarizePost(post);
      console.log(`       → decision: ${decision}, summary: "${summary}"`);

      if (decision === 'keep') {
        // Enregistrement
        console.log(`   ✅ Conserve ${post.id}`);
        await savePost({
          'ID post':          post.id,
          'Compte Instagram': username,
          'Post Instagram':   post.caption,
          'Résumé IA':        summary,
          'Lien':             post.permalink,
          'Date':             post.timestamp,
          'Intéractions':     post.interactions
        });
      } else {
        console.log(`   ❌ Discard ${post.id}`);
      }
    }
    // Pause pour éviter throttling
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('✅ Sync terminée');
}

sync().catch(err => {
  console.error(err);
  process.exit(1);
});