const geocodingUrl = 'https://geocoding-api.open-meteo.com/v1/search'
const forecastUrl = 'https://api.open-meteo.com/v1/forecast'

async function request(url, options, service, timeout = 12_000) {
  let response
  let data
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) })
    data = await response.json()
  } catch {
    throw new Error(`${service} недоступен или вернул некорректный ответ`)
  }
  if (!response.ok || data?.error || data?.ok === false) {
    const code = data?.error_code ?? response.status
    const error = new Error(`${service} вернул ошибку ${code}`)
    error.code = code
    error.service = service
    error.retryAfter = data?.parameters?.retry_after
    throw error
  }
  return data
}

export function telegramApi(token) {
  return async (method, parameters = {}) => {
    const data = await request(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters),
        redirect: 'error'
      },
      `Telegram (${method})`,
      method === 'getUpdates' ? 40_000 : 12_000
    )
    if (data?.ok !== true) throw new Error(`Некорректный ответ Telegram (${method})`)
    return data.result
  }
}

function weatherUrl(base, parameters) {
  const url = new URL(base)
  url.search = new URLSearchParams(parameters)
  return url
}

function normalizeName(value = '') {
  return value.normalize('NFKC').trim().toLowerCase()
    .replaceAll('ё', 'е').replace(/[‐‑–—]/g, '-').replace(/\s+/g, ' ')
}

function matchesCity(city, name) {
  // Open-Meteo also returns geographic features such as airports and mountains.
  if (!city.feature_code?.startsWith('PPL') || normalizeName(city.name) !== name ||
      !Number.isFinite(city.latitude) || !Number.isFinite(city.longitude) || !city.timezone) return false
  try {
    new Intl.DateTimeFormat('ru', { timeZone: city.timezone })
    return true
  } catch {
    return false
  }
}

export async function findCities(input) {
  const query = normalizeName(input)
  if (query.length < 2 || query.length > 120) return []
  const name = query.split(',')[0].trim()
  const languages = /\p{Script=Cyrillic}/u.test(name) ? ['ru', 'en'] : ['en', 'ru']
  // Preserve ё in the API query and fold it only when comparing results.
  const apiQuery = input.trim().normalize('NFKC').toLowerCase()
    .replace(/[‐‑–—]/g, '-').replace(/\s+/g, ' ')
  for (const language of languages) {
    const data = await request(weatherUrl(geocodingUrl, {
      name: apiQuery, language, count: 30, format: 'json'
    }), {}, 'Поиск городов Open-Meteo')
    const cities = (data.results ?? []).filter(city => matchesCity(city, name))
    if (cities.length) {
      return cities.slice(0, 8).map(city => ({
        label: [...new Set([city.name, city.admin2, city.admin1, city.country].filter(Boolean))].join(', '),
        latitude: city.latitude,
        longitude: city.longitude,
        timezone: city.timezone
      }))
    }
  }
  return []
}

const conditions = {
  0: 'ясно', 1: 'преимущественно ясно', 2: 'переменная облачность', 3: 'пасмурно',
  45: 'туман', 48: 'изморозь в тумане',
  51: 'слабая морось', 53: 'морось', 55: 'сильная морось',
  56: 'слабая ледяная морось', 57: 'сильная ледяная морось',
  61: 'слабый дождь', 63: 'дождь', 65: 'сильный дождь',
  66: 'слабый ледяной дождь', 67: 'сильный ледяной дождь',
  71: 'слабый снег', 73: 'снег', 75: 'сильный снег', 77: 'снежные зёрна',
  80: 'слабый ливень', 81: 'ливень', 82: 'сильный ливень',
  85: 'слабый снежный заряд', 86: 'сильный снежный заряд',
  95: 'гроза', 96: 'гроза с мелким градом', 99: 'гроза с сильным градом'
}
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })

export async function weatherReport(city, date) {
  const data = await request(weatherUrl(forecastUrl, {
    latitude: city.latitude,
    longitude: city.longitude,
    timezone: city.timezone,
    current: 'temperature_2m,wind_speed_10m,weather_code',
    daily: 'precipitation_sum',
    temperature_unit: 'celsius',
    wind_speed_unit: 'ms',
    precipitation_unit: 'mm',
    forecast_days: 1
  }), {}, 'Прогноз Open-Meteo')
  const { temperature_2m: temperature, wind_speed_10m: wind, weather_code: code } = data.current ?? {}
  const precipitation = data.daily?.precipitation_sum?.[0]
  if (data.daily?.time?.[0] !== date || ![temperature, wind, code, precipitation].every(Number.isFinite)) {
    throw new Error('Open-Meteo не вернул полную сводку на нужную дату')
  }
  return [
    `Погода в городе ${city.label}`,
    `Температура сейчас: ${number.format(temperature)} °C`,
    `Ветер сейчас: ${number.format(wind)} м/с`,
    `Сейчас: ${conditions[code] ?? 'нет данных об условиях'}`,
    `Осадки за сегодня: ${number.format(precipitation)} мм по прогнозу`
  ].join('\n')
}
