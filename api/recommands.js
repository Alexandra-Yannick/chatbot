import Airtable from 'airtable';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

// ─── Initialisation Airtable ─────────────────────
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID);

// ─── Initialisation OpenAI ───────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Calcul de la distance Haversine ────────────
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = x => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Extracteur de filtres pour Overpass ────────
function parseOverpassFilters(query) {
  const q = (query || '').toLowerCase();
  const filters = [];
  if (q.includes('restaurant')) filters.push('["amenity"="restaurant"]');
  if (q.includes('bar'))        filters.push('["amenity"="bar"]');
  if (q.includes('musée') || q.includes('musee')) filters.push('["tourism"="museum"]');
  if (q.includes('spa'))        filters.push('["spa"="yes"]');
  if (q.includes('vegan'))      filters.push('["diet:vegan"="yes"]');
  if (q.includes('bio'))        filters.push('["organic"="only"]');
  if (q.includes('chinois'))    filters.push('["cuisine"="chinese"]');
  if (!filters.some(f => f.includes('amenity'))) {
    filters.unshift('["amenity"="restaurant"]');
  }
  return filters.join('');
}

// ─── Extraction du rayon en mètres ──────────────
function parseRadius(query) {
  const q = (query || '').toLowerCase();
  const m = q.match(/(\d+)\s*(min|mn|minutes)/);
  if (m) return parseInt(m[1], 10) * 80;
  const km = q.match(/(\d+(?:[.,]\d+)?)\s*km/);
  if (km) return Math.round(parseFloat(km[1].replace(',', '.')) * 1000);
  const m2 = q.match(/(\d+)\s*m\b/);
  if (m2) return parseInt(m2[1], 10);
  return 1000;
}

// ─── Requête Overpass pour récupérer des lieux ───
async function getViaOverpass(lat, lon, radius = 1000, query = '') {
  const filters = parseOverpassFilters(query);
  console.log(`ℹ️ Overpass query around ${radius}m for “${query}”`);
  const overpassQuery = `
[out:json][timeout:5];
(
  node${filters}(around:${radius},${lat},${lon});
  way${filters}(around:${radius},${lat},${lon});
  rel${filters}(around:${radius},${lat},${lon});
);
out center 5;
`;
  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: overpassQuery,
  });
  const data = await response.json();
  return data.elements.slice(0, 5).map(el => {
    const { tags, lat, lon, center } = el;
    const latitude  = el.type === 'node' ? lat : center.lat;
    const longitude = el.type === 'node' ? lon : center.lon;
    return {
      nom:         tags.name || 'Inconnu',
      description: tags.cuisine ? `Cuisine ${tags.cuisine}` : '',
      adresse:     tags['addr:full'] || '',
      latitude,
      longitude
    };
  });
}

// ─── Handler principal ──────────────────────────
export default async function handler(req, res) {
  console.log('↪️ Enter /api/recommands', JSON.stringify(req.body));
  const { messages = [] } = req.body;
  console.log('ℹ️ messages:', messages);

  // 1) Salutation initiale
  if (messages.length === 1 && messages[0].role === 'system') {
    return res.json({
      message: "Bonjour et bienvenue ! Je suis Julie, votre concierge virtuelle. Dites-moi ce que vous recherchez (restaurant, bar, musée, ambiance, etc.) !"
    });
  }

  try {
    // 2) Coordonnées fixes de l’hôtel
    const hotelLat = 44.799999;
    const hotelLon = -0.533330;

    // 3) Chargement des spots depuis Airtable
    const recs = await base('Recommandations').select({ maxRecords: 100 }).firstPage();
    console.log(`ℹ️ Loaded ${recs.length} records from Airtable`);
    const spotsWithDist = recs.map(r => {
      const f   = r.fields;
      const lat = typeof f.Latitude  === 'string'
        ? parseFloat(f.Latitude.replace(',', '.'))
        : f.Latitude;
      const lon = typeof f.Longitude === 'string'
        ? parseFloat(f.Longitude.replace(',', '.'))
        : f.Longitude;
      return {
        nom:         f.Nom || '',
        description: f.Description || '',
        adresse:     f.Adresse    || '',
        latitude:    lat,
        longitude:   lon,
        distance:    parseFloat(haversine(hotelLat, hotelLon, lat, lon).toFixed(1))
      };
    });

    // 4) Filtrer selon la dernière requête utilisateur
    const lastMsg    = (messages.filter(m => m.role === 'user').pop()?.content || '').trim();
    const qNorm      = lastMsg.toLowerCase();
    let finalSpots   = spotsWithDist.filter(s => {
      const name = (s.nom || '').toLowerCase();
      const desc = (s.description || '').toLowerCase();
      return name.includes(qNorm) || desc.includes(qNorm);
    });
    console.log(`ℹ️ ${finalSpots.length} matches in Airtable for "${lastMsg}"`);

    // 5) Fallback Overpass si vide
    if (finalSpots.length === 0) {
      const radius    = parseRadius(lastMsg);
      const via1      = await getViaOverpass(hotelLat, hotelLon, radius, lastMsg);
      finalSpots      = via1.map(r => ({
        ...r,
        distance: parseFloat(haversine(hotelLat, hotelLon, r.latitude, r.longitude).toFixed(1))
      }));
      console.log(`ℹ️ ${finalSpots.length} matches via Overpass at ${radius}m`);
    }

    // 6) Extension jusqu’à 10 000 m si toujours vide
    if (finalSpots.length === 0) {
      for (const r of [2000, 5000, 10000]) {
        const more = await getViaOverpass(hotelLat, hotelLon, r, lastMsg);
        if (more.length) {
          finalSpots = more.map(x => ({
            ...x,
            distance: parseFloat(haversine(hotelLat, hotelLon, x.latitude, x.longitude).toFixed(1))
          }));
          console.log(`ℹ️ Found ${more.length} at extended radius ${r}m`);
          break;
        }
      }
    }

    // 7) Toujours rien ? on propose de reformuler
    if (finalSpots.length === 0) {
      return res.json({
        message: "Désolé, je n’ai trouvé aucun lieu correspondant à votre recherche jusqu’à 10 km. Voulez-vous élargir ou changer de critère ?"
      });
    }

    // 8) Construction du prompt système
    const SYSTEM_PROMPT = `
Tu es Julie, la concierge virtuelle de l’hôtel Comfort Aparthotel Bordeaux Bègles Arena.
À chaque message :
  1. Regarde quelles informations le client t’a déjà données (type, style, quartier, budget, distance).
  2. S’il en manque, **pose uniquement la question suivante** dans l’ordre :
     a) Type d’établissement (restaurant, bar, musée, autre) ?
     b) Style de cuisine ou boisson (italien, vegan, cocktails…) ?
     c) Quartier ou ambiance souhaité (centre-ville, historique, familial, romantique…) ?
     d) Combien de personnes serez vous ?
     e) Budget approximatif (faible, moyen, élevé) ?
     f) Contrainte de distance ou de temps (km, minutes à pied, transport…) ?
  3. Lorsque **toutes** les infos sont obtenues, propose 3 recommandations au format :
     - Nom  
     - Pourquoi je te le recommande  
     - Distance depuis l’hôtel   
  4. Termine par : “Que souhaitez-vous faire maintenant ? Voir l'un des sites, l'itinéraire ou une autre recommandation ?”

**Ne JAMAIS** regrouper plusieurs questions en un seul message.  
Sois chaleureux, reformule la réponse de l’utilisateur si besoin, puis pose ta question unique.
    **Ensuite**, encourage l’utilisateur à donner son avis via émojis :  
    👍 pour dire “j’adore”  
    🤔 pour demander plus de détails  
    🔄 pour d’autres suggestions  
    
    Termine par :  
    Que souhaitez-vous faire maintenant ?
    `.trim();
    // 9) Appel à OpenAI
    const completion = await openai.chat.completions.create({
      model:      'gpt-3.5-turbo',
      temperature: 0.8,
      max_tokens: 300,
      messages: [
        { role: 'system',  content: SYSTEM_PROMPT },
        ...messages
      ]
    });

    // 10) Envoi de la réponse
    return res.json({
      message: completion.choices[0].message.content.trim()
    });

  } catch (err) {
    console.error('❌ Error /api/recommands', err.stack || err);
    return res.status(500).json({ message: "Erreur serveur, réessayez plus tard." });
  }
}