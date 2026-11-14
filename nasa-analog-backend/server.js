const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const spaceTargets = require('./data/spaceTargets.json');
const earthCandidates = require('./data/earthCandidates.json');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// BASE DE DATOS PERSISTENTE
const DB_FILE = path.join(__dirname, 'data', 'database.json');

function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      users: [
        {
          id: 'user-demo-1',
          name: 'Investigador invitado',
          email: 'demo@terratwin.space',
          password: 'demo',
          institution: 'Laboratorio de Exploración Planetaria'
        }
      ],
      discoveries: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
  }
}

initDB();

function readDB() {
  try {
    initDB();
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      discoveries: Array.isArray(parsed.discoveries) ? parsed.discoveries : []
    };
  } catch {
    return { users: [], discoveries: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

const nasaClimateCache = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ENLACES DE GOOGLE MAPS Y COORDENADAS DIRECTAS
function parseGoogleMapsOrCoords(rawInput) {
  const text = rawInput.trim();

  // 1. Pin exacto dentro de URL de Google Maps (!3dLAT!4dLON)
  const exactPinMatch = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  // 2. Centro de vista en URL de Google Maps (@LAT,LON)
  const atCoordsMatch = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  // 3. Parámetro ?q=LAT,LON o ll=LAT,LON
  const queryCoordsMatch = text.match(/[?&](?:q|ll)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i);
  // 4. Coordenadas escritas directamente: "24.0277, -104.6532"
  const plainCoordsMatch = text.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);

  const match = exactPinMatch || queryCoordsMatch || atCoordsMatch || plainCoordsMatch;
  if (!match) return null;

  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Number.isNaN(lat) || Number.isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }

  // Extraer nombre del lugar si viene en la URL (/place/Nombre+Del+Lugar/)
  let extractedName = '';
  const placeMatch = text.match(/\/place\/([^/@]+)/);
  if (placeMatch && placeMatch[1]) {
    try {
      extractedName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
    } catch {
      extractedName = placeMatch[1].replace(/\+/g, ' ').trim();
    }
  }

  return { lat, lon, extractedName };
}

// GEOCODIFICACIÓN INVERSA Y BÚSQUEDA MULTI-FUENTE
async function reverseGeocodeCoords(lat, lon) {
  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: {
        format: 'jsonv2',
        lat: lat.toFixed(5),
        lon: lon.toFixed(5),
        'accept-language': 'es'
      },
      headers: {
        'User-Agent': 'TerraTwin-NASA-SpaceApps/3.1 (educational-project)'
      },
      timeout: 4500
    });

    const addr = response.data?.address || {};
    const specificFeature =
      response.data?.name ||
      addr.natural ||
      addr.volcano ||
      addr.peak ||
      addr.protected_area ||
      addr.desert ||
      '';

    let city =
      addr.city ||
      addr.town ||
      addr.village ||
      addr.municipality ||
      addr.county ||
      addr.region ||
      '';

    if (city.toLowerCase().includes('victoria de durango')) {
      city = 'Durango';
    }

    const state = addr.state || '';
    const country = addr.country || '';

    const parts = [specificFeature, city, state, country].filter(
      (p, idx, arr) => p && arr.indexOf(p) === idx
    );

    if (parts.length > 0) {
      return {
        placeName: parts.slice(0, 3).join(', '),
        regionSubtitle: [state, country].filter(Boolean).join(', ') || 'Coordenada satelital'
      };
    }

    return {
      placeName: `Sector (${lat.toFixed(4)}°, ${lon.toFixed(4)}°)`,
      regionSubtitle: 'Coordenada satelital'
    };
  } catch {
    return {
      placeName: `Sector (${lat.toFixed(4)}°, ${lon.toFixed(4)}°)`,
      regionSubtitle: 'Coordenada satelital'
    };
  }
}

// 1. NASA POWER con validación completa de los 4 parámetros y caché por cuadrícula
async function fetchNasaPowerByCoords(lat, lon, cacheKey = null, fallback = null) {
  const effectiveKey = cacheKey || `grid-${lat.toFixed(2)}-${lon.toFixed(2)}`;
  if (nasaClimateCache.has(effectiveKey)) {
    return { ...nasaClimateCache.get(effectiveKey), source: 'NASA POWER (caché)' };
  }

  try {
    const url = 'https://power.larc.nasa.gov/api/temporal/climatology/point';
    const response = await axios.get(url, {
      params: {
        parameters: 'T2M_MIN,T2M_MAX,ALLSKY_SFC_SW_DWN,PRECTOTCORR',
        community: 'RE',
        longitude: Number(lon.toFixed(4)),
        latitude: Number(lat.toFixed(4)),
        format: 'JSON'
      },
      timeout: 5500
    });

    const p = response.data?.properties?.parameter;
    const tMinRaw = p?.T2M_MIN?.ANN;
    const tMaxRaw = p?.T2M_MAX?.ANN;
    const solarRaw = p?.ALLSKY_SFC_SW_DWN?.ANN;
    const precipRaw = p?.PRECTOTCORR?.ANN;

    const isValid = [tMinRaw, tMaxRaw, solarRaw, precipRaw].every(
      (v) => typeof v === 'number' && Number.isFinite(v) && v > -900
    );

    if (!isValid) {
      throw new Error('Parámetros incompletos (-999) en NASA POWER');
    }

    const climateData = {
      tMin: Number(tMinRaw.toFixed(2)),
      tMax: Number(tMaxRaw.toFixed(2)),
      solar: Number(solarRaw.toFixed(2)),
      precip: Number(Math.max(0, precipRaw).toFixed(2))
    };

    nasaClimateCache.set(effectiveKey, climateData);
    return { ...climateData, source: 'NASA POWER Satelital (en vivo)' };
  } catch {
    if (fallback) {
      return { ...fallback, source: 'Base científica local' };
    }
    const absLat = Math.abs(lat);
    return {
      tMin: Number((22 - absLat * 0.65).toFixed(1)),
      tMax: Number((38 - absLat * 0.45).toFixed(1)),
      solar: Number(clamp(6.8 - absLat * 0.05, 2.1, 7.2).toFixed(2)),
      precip: 1.2,
      source: 'Estimación orbital local'
    };
  }
}

// 2. Elevación y pendiente topográfica real mediante gradiente DEM de 5 puntos (Open-Meteo + fallback)
async function fetchTerrainMetricsByCoords(lat, lon) {
  const delta = 0.01; // ~1.1 km de radio para calcular gradiente de pendiente real
  const lats = [lat, clamp(lat + delta, -89.9, 89.9), clamp(lat - delta, -89.9, 89.9), lat, lat]
    .map((v) => v.toFixed(4))
    .join(',');
  const lons = [lon, lon, lon, clamp(lon + delta, -179.9, 179.9), clamp(lon - delta, -179.9, 179.9)]
    .map((v) => v.toFixed(4))
    .join(',');

  try {
    const res = await axios.get('https://api.open-meteo.com/v1/elevation', {
      params: { latitude: lats, longitude: lons },
      timeout: 4000
    });
    const elevs = res.data?.elevation;
    if (Array.isArray(elevs) && elevs.length === 5 && typeof elevs[0] === 'number') {
      const centerElev = Math.round(elevs[0]);
      const dLatMeters = 2 * delta * 111320;
      const dLonMeters = Math.max(100, 2 * delta * 111320 * Math.cos((lat * Math.PI) / 180));
      const dzDy = (elevs[1] - elevs[2]) / dLatMeters;
      const dzDx = (elevs[3] - elevs[4]) / dLonMeters;
      const slopeRad = Math.atan(Math.sqrt(dzDx * dzDx + dzDy * dzDy));
      const slopeDeg = Number(((slopeRad * 180) / Math.PI).toFixed(1));
      const slopeIndex = clamp(Math.round((slopeDeg / 30) * 100), 10, 98);
      return { elevation: centerElev, slopeIndex, slopeDegrees: slopeDeg };
    }
  } catch {
    // Fallback a Open-Elevation puntual
  }

  try {
    const response = await axios.get('https://api.open-elevation.com/api/v1/lookup', {
      params: { locations: `${lat.toFixed(4)},${lon.toFixed(4)}` },
      timeout: 3500
    });
    const elev = response.data?.results?.[0]?.elevation;
    if (typeof elev === 'number') {
      return { elevation: Math.round(elev), slopeIndex: 50, slopeDegrees: 12.0 };
    }
  } catch {
    // Sin datos DEM disponibles
  }

  return { elevation: null, slopeIndex: 50, slopeDegrees: 12.0 };
}

async function fetchElevationByCoords(lat, lon) {
  const terrain = await fetchTerrainMetricsByCoords(lat, lon);
  return terrain.elevation;
}

// 3. Perfil normalizado sin inversión de escala en geología ni cuevas
function buildEarthNormalizedProfile(site, climate, target) {
  const thermal = clamp(((30 - climate.tMin) / 70) * 100, 0, 100);
  const radiation = clamp(((climate.solar - 2.0) / 5.5) * 100, 0, 100);
  const aridity = clamp(((3.0 - Math.min(climate.precip, 3.0)) / 3.0) * 100, 0, 100);
  const topography = clamp(site.slopeIndex, 0, 100);

  // Alineación directa con la escala del objetivo para evitar penalizar coincidencias exactas
  let geology = Math.max(20, target.profile.geology - 45);
  if (site.geologyType === target.requiredGeology) {
    geology = target.profile.geology; // 100% de coincidencia en esta dimensión
  } else if (
    (site.geologyType === 'basaltic-volcanic' && target.requiredGeology === 'anorthosite-regolith') ||
    (site.geologyType === 'permafrost-regolith' && target.requiredGeology === 'anorthosite-regolith')
  ) {
    geology = Math.max(0, target.profile.geology - 18); // 82% de coincidencia parcial
  }

  let subsurface = target.profile.subsurface;
  if (target.requiresCaves) {
    subsurface = site.hasCaves ? target.profile.subsurface : 10;
  } else {
    // Si la misión es en superficie abierta y no hay cuevas, coincidencia total (diff = 0)
    subsurface = site.hasCaves ? Math.min(100, target.profile.subsurface + 20) : target.profile.subsurface;
  }

  return {
    thermal: Math.round(thermal),
    radiation: Math.round(radiation),
    aridity: Math.round(aridity),
    topography: Math.round(topography),
    geology: Math.round(geology),
    subsurface: Math.round(subsurface)
  };
}

function calculateSimilarity(targetProfile, earthProfile, weights) {
  const dimensions = ['thermal', 'radiation', 'aridity', 'topography', 'geology', 'subsurface'];
  let weightedErrorSum = 0;
  let totalWeight = 0;

  for (const dim of dimensions) {
    const w = typeof weights[dim] === 'number' ? Math.max(0, weights[dim]) : 50;
    const diff = Math.abs(targetProfile[dim] - earthProfile[dim]);
    weightedErrorSum += w * diff;
    totalWeight += w;
  }

  if (totalWeight === 0) {
    totalWeight = dimensions.length;
    weightedErrorSum = dimensions.reduce(
      (acc, dim) => acc + Math.abs(targetProfile[dim] - earthProfile[dim]),
      0
    );
  }

  const meanWeightedDiff = weightedErrorSum / totalWeight;
  return Number(clamp(100 - meanWeightedDiff, 0, 100).toFixed(1));
}

// 4. Diagnóstico completo de las 6 dimensiones + protocolos científicos de prueba
function generateScientificCritique(target, earthProfile, climate) {
  const dimMeta = [
    {
      key: 'thermal',
      name: 'Frío extremo',
      strong: `Sus temperaturas mínimas (${climate.tMin} °C) permiten probar baterías, lubricantes y electrónica bajo estrés térmico.`,
      weak: `No alcanza el frío extremo de ${target.name} (${target.rawSpecs.tempRange}), por lo que requiere cámaras criogénicas complementarias.`
    },
    {
      key: 'radiation',
      name: 'Luz y energía solar',
      strong: `La irradiancia solar (${climate.solar} kWh/m²/día) es óptima para calibrar paneles fotovoltaicos y balances energéticos.`,
      weak: `La disponibilidad solar (${climate.solar} kWh/m²/día) difiere del régimen lumínico real de ${target.name}.`
    },
    {
      key: 'aridity',
      name: 'Sequedad del terreno',
      strong: `La baja precipitación (${climate.precip} mm/día) conserva el regolito seco y evita falsos positivos por humedad.`,
      weak: `Presenta mayor precipitación (${climate.precip} mm/día) que el entorno hiperárido de ${target.celestialBody}.`
    },
    {
      key: 'topography',
      name: 'Relieve e inclinación',
      strong: `El gradiente de pendiente permite ensayar tracción, estabilidad de aterrizadores y navegación autónoma (LiDAR/VO).`,
      weak: `La rugosidad del terreno difiere de la morfología real de ${target.name} (${target.rawSpecs.terrain}).`
    },
    {
      key: 'geology',
      name: 'Tipo de roca y suelo',
      strong: `La mineralogía coincide para validar taladros rotativos, espectrómetros Raman/LIBS y procesos ISRU.`,
      weak: `La litología superficial varía respecto a ${target.name}; se recomienda complementar con simulante de regolito.`
    },
    {
      key: 'subsurface',
      name: 'Cuevas y refugios',
      strong: target.requiresCaves
        ? `Posee cavidades o tubos volcánicos reales para ensayar exploración espeleológica robótica y blindaje contra radiación.`
        : `Terreno despejado en superficie acorde al perfil operativo de ${target.name}.`,
      weak: target.requiresCaves
        ? `Carece de accesos subterráneos naturales para simular las claraboyas de ${target.name}.`
        : `La presencia de cavidades subterráneas excede los requerimientos de superficie de esta misión.`
    }
  ];

  const rankedDims = dimMeta
    .map((d) => {
      const diff = Math.abs(target.profile[d.key] - earthProfile[d.key]);
      const matchPct = Math.max(0, 100 - diff);
      return { ...d, diff, matchPct };
    })
    .sort((a, b) => a.diff - b.diff);

  const strongAnalogies = rankedDims.slice(0, 3).map((d) => ({
    dimension: d.name,
    matchPct: d.matchPct,
    detail: d.strong
  }));

  const analogyGaps = rankedDims
    .slice(3)
    .reverse()
    .map((d) => ({
      dimension: d.name,
      matchPct: d.matchPct,
      detail: d.weak
    }));

  const planetaryLimitations =
    target.celestialBody === 'Luna'
      ? [
          'Gravedad reducida (1/6 g): altera la mecánica de excavación, el anclaje de taladros y la tracción de rovers.',
          'Vacío ultra-alto (10⁻¹² torr): inexistencia de convección atmosférica y sublimación inmediata de volátiles expuestos.',
          'Regolito abrasivo cargado electrostáticamente por viento solar y radiación UV sin filtro.'
        ]
      : [
          'Gravedad marciana (0.38 g): modifica la estabilidad en pendientes y la dinámica de perforación profunda.',
          'Atmósfera tenue de CO₂ (~6-7 mbar): impide pruebas aerodinámicas directas de paracaídas o helicópteros sin cámaras de baja presión.',
          'Percloratos oxidantes en el suelo y radiación cósmica/UV constante sin magnetosfera global.'
        ];

  const validationProtocols = [
    target.requiresCaves
      ? 'Despliegue de rovers con tethering y mapeo LiDAR 3D autónomo sin señal GNSS en tubos volcánicos.'
      : 'Pruebas de navegación autónoma basada en visión (Visual Odometry) y evasión de obstáculos en terreno análogo.',
    `Calibración de espectrómetros de composición mineral y ensayos de extracción ISRU sobre ${target.requiredGeology}.`,
    `Validación de ciclos de carga/descarga térmica y gestión de energía solar (${climate.solar} kWh/m²/día).`
  ];

  return {
    strongAnalogies,
    analogyGaps,
    planetaryLimitations,
    validationProtocols
  };
}

// AUTENTICACIÓN DE USUARIOS
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, institution } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Completa tu nombre, correo electrónico y contraseña.' });
  }

  const db = readDB();
  const exists = db.users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'Ese correo ya está registrado. Inicia sesión con tu cuenta.' });
  }

  const newUser = {
    id: `user-${Date.now()}`,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    password: password.trim(),
    institution: (institution || 'Investigación independiente').trim()
  };

  db.users.push(newUser);
  writeDB(db);

  const { password: _, ...safeUser } = newUser;
  res.json(safeUser);
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Ingresa tu correo y contraseña.' });
  }

  const db = readDB();
  const user = db.users.find(
    (u) => u.email.toLowerCase() === email.trim().toLowerCase() && u.password === password.trim()
  );

  if (!user) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }

  const { password: _, ...safeUser } = user;
  res.json(safeUser);
});

app.post('/api/auth/demo', (req, res) => {
  const db = readDB();
  let demoUser = db.users.find((u) => u.id === 'user-demo-1');
  if (!demoUser) {
    demoUser = {
      id: 'user-demo-1',
      name: 'Investigador invitado',
      email: 'demo@terratwin.space',
      password: 'demo',
      institution: 'Laboratorio de Exploración Planetaria'
    };
    db.users.push(demoUser);
    writeDB(db);
  }
  const { password: _, ...safeUser } = demoUser;
  res.json(safeUser);
});

// BUSCADOR DE UBICACIONES
function translatePlaceCategory(rawType = '') {
  const t = String(rawType).toLowerCase();
  if (t.includes('volcano') || t.includes('peak') || t.includes('mountain')) return 'Formación volcánica / montaña';
  if (t.includes('desert') || t.includes('natural') || t.includes('park') || t.includes('reserve')) return 'Área natural';
  if (t.includes('city') || t.includes('town') || t.includes('municipality') || t.includes('locality')) return 'Ciudad / Municipio';
  if (t.includes('village') || t.includes('hamlet')) return 'Localidad';
  if (t.includes('university') || t.includes('college') || t.includes('school')) return 'Institución';
  if (t.includes('admin') || t.includes('state') || t.includes('region')) return 'Región / Estado';
  return 'Ubicación geográfica';
}

app.get('/api/geocode', async (req, res) => {
  const q = req.query.q;
  if (!q || typeof q !== 'string' || q.trim().length < 2) {
    return res.status(400).json({ error: 'Escribe al menos 2 letras del lugar que deseas buscar.' });
  }

  const rawQuery = q.trim();

  try {
    // Soporte directo para enlaces de Google Maps y coordenadas "lat, lon"
    const directCoords = parseGoogleMapsOrCoords(rawQuery);
    if (directCoords) {
      const rev = await reverseGeocodeCoords(directCoords.lat, directCoords.lon);
      const label = directCoords.extractedName || rev.placeName;
      return res.json({
        query: rawQuery,
        results: [
          {
            name: label,
            subtitle: rev.regionSubtitle,
            fullName: `${label} (${directCoords.lat.toFixed(4)}°, ${directCoords.lon.toFixed(4)}°)`,
            lat: Number(directCoords.lat.toFixed(5)),
            lon: Number(directCoords.lon.toFixed(5)),
            type: 'Coordenada / Enlace de mapa'
          }
        ]
      });
    }

    // 3 geocodificadores para máxima velocidad y precisión
    const [arcgisRes, openMeteoRes, photonRes] = await Promise.allSettled([
      axios.get('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates', {
        params: {
          SingleLine: rawQuery,
          outFields: 'Match_addr,PlaceName,Region,Country,Type',
          maxLocations: 7,
          langCode: 'ES',
          f: 'json'
        },
        timeout: 4500
      }),
      axios.get('https://geocoding-api.open-meteo.com/v1/search', {
        params: {
          name: rawQuery,
          count: 7,
          language: 'es',
          format: 'json'
        },
        timeout: 4500
      }),
      axios.get('https://photon.komoot.io/api/', {
        params: {
          q: rawQuery,
          limit: 6
        },
        timeout: 4500
      })
    ]);

    const candidates = [];

    const addCandidate = (name, subtitle, lat, lon, rawType) => {
      if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) {
        return;
      }
      const cleanLat = Number(lat.toFixed(5));
      const cleanLon = Number(lon.toFixed(5));
      const isDuplicate = candidates.some(
        (c) => Math.abs(c.lat - cleanLat) < 0.02 && Math.abs(c.lon - cleanLon) < 0.02
      );
      if (isDuplicate) return;

      const cleanName = (name || rawQuery).trim();
      const cleanSub = (subtitle || '').trim();
      const fullName = cleanSub && !cleanName.includes(cleanSub)
        ? `${cleanName}, ${cleanSub}`
        : cleanName;

      candidates.push({
        name: cleanName,
        subtitle: cleanSub || 'Coordenada global',
        fullName,
        lat: cleanLat,
        lon: cleanLon,
        type: translatePlaceCategory(rawType)
      });
    };

    if (arcgisRes.status === 'fulfilled' && Array.isArray(arcgisRes.value.data?.candidates)) {
      for (const item of arcgisRes.value.data.candidates) {
        const attr = item.attributes || {};
        const loc = item.location || {};
        const placeName = attr.PlaceName || (attr.Match_addr ? attr.Match_addr.split(',')[0] : rawQuery);
        const subParts = [attr.Region, attr.Country].filter(
          (v, i, arr) => v && v !== placeName && arr.indexOf(v) === i
        );
        addCandidate(placeName, subParts.join(', '), loc.y, loc.x, attr.Type);
      }
    }

    if (openMeteoRes.status === 'fulfilled' && Array.isArray(openMeteoRes.value.data?.results)) {
      for (const item of openMeteoRes.value.data.results) {
        const subParts = [item.admin1, item.country].filter(
          (v, i, arr) => v && v !== item.name && arr.indexOf(v) === i
        );
        addCandidate(item.name, subParts.join(', '), item.latitude, item.longitude, item.feature_code);
      }
    }

    if (photonRes.status === 'fulfilled' && Array.isArray(photonRes.value.data?.features)) {
      for (const feat of photonRes.value.data.features) {
        const props = feat.properties || {};
        const coords = feat.geometry?.coordinates || [];
        if (coords.length < 2) continue;
        const primary = props.name || props.city || props.state || rawQuery;
        const subParts = [props.city !== primary ? props.city : '', props.state, props.country].filter(
          (v, i, arr) => v && v !== primary && arr.indexOf(v) === i
        );
        addCandidate(primary, subParts.join(', '), Number(coords[1]), Number(coords[0]), props.osm_value);
      }
    }

    res.json({
      query: rawQuery,
      results: candidates.slice(0, 8)
    });
  } catch (err) {
    console.error('Error en /api/geocode:', err.message);
    res.status(500).json({ error: 'No se pudo consultar el servicio de ubicaciones.' });
  }
});

// SIMULACIÓN Y PROSPECCIÓN NASA
app.get('/api/health', (req, res) => {
  const db = readDB();
  res.json({
    status: 'OK',
    databaseFile: DB_FILE,
    usersCount: db.users.length,
    discoveriesCount: db.discoveries.length
  });
});

app.get('/api/targets', (req, res) => {
  res.json(spaceTargets);
});

app.post('/api/match', async (req, res) => {
  try {
    const { targetId, weights = {} } = req.body;
    const target = spaceTargets.find((t) => t.id === targetId) || spaceTargets[0];

    const evaluatedSites = await Promise.all(
      earthCandidates.map(async (site) => {
        const climate = await fetchNasaPowerByCoords(site.lat, site.lon, site.id, site.fallbackClimate);
        const earthProfile = buildEarthNormalizedProfile(site, climate, target);
        const planetarySimilarity = calculateSimilarity(target.profile, earthProfile, weights);

        const missionReadinessScore = Number(
          (planetarySimilarity * 0.65 + site.logisticViability * 0.35).toFixed(1)
        );

        return {
          id: site.id,
          name: site.name,
          country: site.country,
          category: site.category || 'understudied',
          isCustom: false,
          lat: site.lat,
          lon: site.lon,
          geologyType: site.geologyType,
          hasCaves: site.hasCaves,
          highlights: site.highlights,
          logisticNotes: site.logisticNotes,
          climateData: climate,
          scores: {
            planetarySimilarity,
            logisticViability: site.logisticViability,
            missionReadinessScore
          },
          critique: generateScientificCritique(target, earthProfile, climate),
          radarComparison: {
            labels: ['Frío extremo', 'Luz solar', 'Sequedad', 'Relieve', 'Tipo de roca', 'Cuevas'],
            targetValues: [
              target.profile.thermal,
              target.profile.radiation,
              target.profile.aridity,
              target.profile.topography,
              target.profile.geology,
              target.profile.subsurface
            ],
            earthValues: [
              earthProfile.thermal,
              earthProfile.radiation,
              earthProfile.aridity,
              earthProfile.topography,
              earthProfile.geology,
              earthProfile.subsurface
            ]
          }
        };
      })
    );

    evaluatedSites.sort((a, b) => b.scores.planetarySimilarity - a.scores.planetarySimilarity);

    res.json({
      target,
      totalAnalyzed: evaluatedSites.length,
      results: evaluatedSites
    });
  } catch (error) {
    console.error('Error en /api/match:', error);
    res.status(500).json({ error: 'Error al procesar el análisis' });
  }
});

app.post('/api/prospect', async (req, res) => {
  try {
    const {
      lat,
      lon,
      targetId,
      weights = {},
      geologyType = 'basaltic-volcanic',
      hasCaves = false,
      preferredName = ''
    } = req.body;

    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return res.status(400).json({ error: 'Coordenadas inválidas' });
    }

    const target = spaceTargets.find((t) => t.id === targetId) || spaceTargets[0];

    const [climate, terrain, geoInfo] = await Promise.all([
      fetchNasaPowerByCoords(lat, lon),
      fetchTerrainMetricsByCoords(lat, lon),
      reverseGeocodeCoords(lat, lon)
    ]);

    const finalPlaceName =
      typeof preferredName === 'string' && preferredName.trim().length > 0
        ? preferredName.trim()
        : geoInfo.placeName;

    const isWaterBody =
      terrain.elevation !== null &&
      terrain.elevation <= 0 &&
      geoInfo.regionSubtitle === 'Coordenada satelital';

    const customSite = {
      id: `custom-${lat.toFixed(4)}-${lon.toFixed(4)}`,
      name: finalPlaceName,
      country: isWaterBody
        ? 'Zona oceánica / Cuerpo de agua · No apto para aterrizaje terrestre'
        : terrain.elevation !== null
          ? `${geoInfo.regionSubtitle} · Altitud: ${terrain.elevation} m · Pendiente: ${terrain.slopeDegrees}°`
          : geoInfo.regionSubtitle,
      category: 'custom',
      isCustom: true,
      isWaterBody,
      elevation: terrain.elevation,
      slopeDegrees: terrain.slopeDegrees,
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      geologyType,
      hasCaves,
      slopeIndex: terrain.slopeIndex,
      logisticViability: isWaterBody ? 5 : Math.abs(lat) > 65 ? 30 : 84
    };

    const earthProfile = buildEarthNormalizedProfile(customSite, climate, target);
    const planetarySimilarity = calculateSimilarity(target.profile, earthProfile, weights);
    const missionReadinessScore = Number(
      (planetarySimilarity * 0.65 + customSite.logisticViability * 0.35).toFixed(1)
    );

    res.json({
      ...customSite,
      highlights: isWaterBody
        ? `Coordenada detectada sobre océano o cuerpo de agua (${lat.toFixed(4)}°, ${lon.toFixed(4)}°). No apta para operaciones terrestres.`
        : `Ubicación exacta en ${finalPlaceName} (${lat.toFixed(4)}°, ${lon.toFixed(
            4
          )}°). Altitud aproximada: ${terrain.elevation !== null ? terrain.elevation + ' m s.n.m.' : 'no disponible'} · Pendiente media: ${terrain.slopeDegrees}°.`,
      logisticNotes: isWaterBody
        ? 'Requiere selección de terreno continental firme para desplegar rovers o módulos de aterrizaje.'
        : Math.abs(lat) > 65
          ? 'Zona polar remota: requiere logística especializada.'
          : 'Ubicación accesible para estudios de campo y validación de instrumentos.',
      climateData: climate,
      scores: {
        planetarySimilarity,
        logisticViability: customSite.logisticViability,
        missionReadinessScore
      },
      critique: generateScientificCritique(target, earthProfile, climate),
      radarComparison: {
        labels: ['Frío extremo', 'Luz solar', 'Sequedad', 'Relieve', 'Tipo de roca', 'Cuevas'],
        targetValues: [
          target.profile.thermal,
          target.profile.radiation,
          target.profile.aridity,
          target.profile.topography,
          target.profile.geology,
          target.profile.subsurface
        ],
        earthValues: [
          earthProfile.thermal,
          earthProfile.radiation,
          earthProfile.aridity,
          earthProfile.topography,
          earthProfile.geology,
          earthProfile.subsurface
        ]
      }
    });
  } catch (error) {
    console.error('Error en /api/prospect:', error);
    res.status(500).json({ error: 'Error al explorar la coordenada' });
  }
});

// BASE DE DATOS PERSONALIZADA POR USUARIO
app.get('/api/discoveries', (req, res) => {
  const { userId } = req.query;
  const db = readDB();

  if (userId) {
    const userRecords = db.discoveries.filter(
      (item) => item.userId === userId || (!item.userId && userId === 'user-demo-1')
    );
    return res.json(userRecords);
  }

  res.json(db.discoveries);
});

app.post('/api/discoveries', (req, res) => {
  const { site, targetName, customName, notes, user } = req.body;
  if (!site) return res.status(400).json({ error: 'Faltan datos del sitio' });

  const db = readDB();
  const finalName = (customName && customName.trim()) || site.name;

  const newRecord = {
    ...site,
    id: `db-${Date.now()}`,
    userId: user?.id || 'user-demo-1',
    name: finalName,
    highlights: (notes && notes.trim()) || site.highlights,
    savedAt: new Date().toLocaleDateString('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }),
    matchedTargetName: targetName || 'Misión espacial',
    authorName: user?.name || 'Investigador invitado',
    authorInstitution: user?.institution || 'Terra-Twin Lab'
  };

  db.discoveries.unshift(newRecord);
  writeDB(db);
  res.json(newRecord);
});

app.delete('/api/discoveries/:id', (req, res) => {
  const db = readDB();
  const { userId } = req.query;
  db.discoveries = db.discoveries.filter(
    (item) => !(item.id === req.params.id && (!userId || item.userId === userId))
  );
  writeDB(db);
  res.json({ deleted: true });
});

app.listen(PORT, () => {
  console.log(`Servidor Terra-Twin activo en http://localhost:${PORT}`);
  console.log(`Base de datos persistente: ${DB_FILE}`);
});