// scrap-instagram-simple.js
// Script Node.js sans Puppeteer, utilisant l’endpoint public Instagram iOS pour récupérer les posts et les importer dans Airtable.

import Airtable from 'airtable';
import fetch from 'node-fetch';
import 'dotenv/config';

const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID } = process.env;
if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('⚠️ Définis AIRTABLE_API_KEY et AIRTABLE_BASE_ID dans .env');
  process.exit(1);
}

// Config Airtable
Airtable.configure({ apiKey: AIRTABLE_API_KEY });
const base = new Airtable().base(AIRTABLE_BASE_ID);
const POSTS_LIMIT = 5;

// 1) Récupère la liste des influenceurs depuis Airtable
async function getInfluencers() {
  const recs = await base('Influencers')
    .select({ view: 'Grid view', fields: ['Account'] })
    .all();
  return recs.map(r => r.get('Account')).filter(Boolean);
}

// 2) Vérifie l'existence d'un post dans la table Posts
async function recordExists(postId) {
  const recs = await base('Posts')
    .select({ filterByFormula: `{ID post} = "${postId}"`, maxRecords: 1 })
    .firstPage();
  return recs.length > 0;
}

// 3) Sauvegarde un post dans Airtable
async function savePost(postFields) {
  await base('Posts').create([{ fields: postFields }]);
}

// 4) FetchProfile utilisant l'endpoint iOS public
async function fetchProfile(username) {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Instagram 155.0.0.37.107 (iPhone13,4; iOS 14.0; Scale/3.00)',
      'x-ig-app-id': '936619743392459'
    }
  });
  if (!res.ok) throw new Error(`Request ${res.status} for ${username}`);
  const json = await res.json();
  const user = json.data?.user;
  if (!user) throw new Error(`User JSON non trouvé pour ${username}`);
  return user;
}

// 5) Logique de sync
async function sync() {
  console.log('🚀 Démarrage du scraping Instagram via endpoint iOS...');
  const influencers = await getInfluencers();
  for (const username of influencers) {
    console.log(`↪️  Scraping @${username}`);
    let user;
    try {
      user = await fetchProfile(username);
    } catch (err) {
      console.warn(`Erreur fetch pour @${username}:`, err.message);
      continue;
    }

    const edges = user.edge_owner_to_timeline_media?.edges || [];
    for (const edge of edges.slice(0, POSTS_LIMIT)) {
      const node = edge.node;
      const postFields = {
        'ID post': node.id,
        'Compte Instagram': username,
        'Post Instagram': node.edge_media_to_caption.edges[0]?.node?.text || '',
        'lien': `https://www.instagram.com/p/${node.shortcode}/`,
        'date': new Date(node.taken_at_timestamp * 1000).toISOString(),
        'Intéractions': node.edge_liked_by.count + node.edge_media_to_comment.count
      };
      if (!(await recordExists(node.id))) {
        console.log(`   + Import du post ${node.id}`);
        await savePost(postFields);
      } else {
        console.log(`   - Post ${node.id} déjà existant`);
      }
    }
    // petite pause
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('✅ Sync terminée');
}

sync().catch(err => {
  console.error(err);
  process.exit(1);
});
