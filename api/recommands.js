import Airtable from 'airtable';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

// Initialisation Airtable
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID);

// Initialisation OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Fonction haversine pour calculer la distance en km
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Analyse dynamique des filtres Overpass
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
  if (!filters.some((f) => f.includes('amenity'))) {
    filters.unshift('["amenity"="restaurant"]');
  }
  return filters.join('');
}

// Extraction du rayon depuis la requête (en mètres)
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

// Requête Overpass dynamique
async function getViaOverpass(lat, lon, radius = 1000, query = '') {
  const filters = parseOverpassFilters(query);
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
  return data.elements.slice(0, 5).map((el) => {
    const { tags, lat, lon, center } = el;
    const latitude  = el.type === 'node' ? lat : center.lat;
    const longitude = el.type === 'node' ? lon : center.lon;
    return {
      nom:         tags.name || 'Inconnu',
      description: tags.cuisine ? `Cuisine ${tags.cuisine}` : '',
      adresse:     tags['addr:full'] || '',
      latitude,
      longitude,
    };
  });
}

export default async function handler(req, res) {
  const { messages = [] } = req.body;

  // Salutation initiale
  if (messages.length === 1 && messages[0].role === 'system') {
    return res.json({
      message: "Bonjour et bienvenue ! Je suis Julie, votre concierge virtuelle. Dites-moi ce que vous recherchez (restaurant, bar, musée, ambiance, etc.) !",
    });
  }

  try {
    // Coordonnées statiques de l'hôtel
    const hotelLat = 44.799999;
    const hotelLon = -0.533330;

    // Chargement des spots Airtable
    const recs = await base('Recommandations').select({ maxRecords: 100 }).firstPage();
    const spotsWithDist = recs.map((r) => {
      const f = r.fields;
      const lat = typeof f.Latitude === 'string'
        ? parseFloat(f.Latitude.replace(',', '.'))
        : f.Latitude;
      const lon = typeof f.Longitude === 'string'
        ? parseFloat(f.Longitude.replace(',', '.'))
        : f.Longitude;
      return {
        nom:         f.Nom,
        description: f.Description || '',
        adresse:     f.Adresse || '',
        latitude:    lat,
        longitude:   lon,
        distance:    haversine(hotelLat, hotelLon, lat, lon).toFixed(1),
      };
    });

    // Vérification
    if (!Array.isArray(spotsWithDist)) {
      console.error('❌ spotsWithDist is not an array', spotsWithDist);
      return res.status(500).json({ message: "Erreur interne, réessayez plus tard." });
    }

    // Dernière requête utilisateur
    const lastQueryMsg = messages.filter((m) => m.role === 'user').pop()?.content || '';
    const normalized = lastQueryMsg.toLowerCase();

    // 1) Filtrage interne
    let finalSpots = spotsWithDist.filter((s) => {
      const name = s.nom || '';
      const desc = s.description || '';
      return name.toLowerCase().includes(normalized)
          || desc.toLowerCase().includes(normalized);
    });

    // 2) Fallback Overpass initial
    if (finalSpots.length === 0) {
      const radius = parseRadius(lastQueryMsg);
      console.log('↪️ Fallback Overpass initial', radius, 'm pour', lastQueryMsg);
      const overpassResults = await getViaOverpass(hotelLat, hotelLon, radius, lastQueryMsg);
      finalSpots = overpassResults.map((r) => ({
        ...r,
        distance: haversine(hotelLat, hotelLon, r.latitude, r.longitude).toFixed(1),
      }));
    }

    // 3) Fallback élargi si toujours vide
    if (finalSpots.length === 0) {
      for (const r of [2000, 5000, 10000]) {
        console.log(`↪️ Overpass étendu à ${r} m pour ${lastQueryMsg}`);
        const more = await getViaOverpass(hotelLat, hotelLon, r, lastQueryMsg);
        if (more.length) {
          finalSpots = more.map((x) => ({
            ...x,
            distance: haversine(hotelLat, hotelLon, x.latitude, x.longitude).toFixed(1),
          }));
          break;
        }
      }
    }

    // 4) Aucun résultat
    if (finalSpots.length === 0) {
      return res.json({
        message: "Désolé, je n'ai trouvé aucun lieu correspondant à votre recherche jusqu'à 10 km. Voulez-vous élargir ou changer de critère ?",
      });
    }

    // 5) Construction du prompt système
    const systemPrompt = [
      {
        role: 'system',
        content: `Tu es Julie, concierge virtuelle servie et concise. L’utilisateur est à l’hôtel (lat:${hotelLat}, lon:${hotelLon}).\n` +
                 `Voici les spots disponibles selon sa requête :\n` +
                 '```json\n' +
                 JSON.stringify(finalSpots, null, 2) +
                 '\n```',
      }
    ];

    // 6) Appel OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      temperature: 0.8,
      max_tokens: 300,
      messages: [ ...systemPrompt, ...messages ],
    });

    // 7) Réponse
    return res.json({ message: completion.choices[0].message.content.trim() });

  } catch (err) {
    console.error('❌ Error /api/recommands', err.stack || err);
    return res.status(500).json({ message: "Erreur serveur, réessayez plus tard." });
  }
}
