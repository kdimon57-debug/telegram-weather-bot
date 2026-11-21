import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBot } from '../src/bot.js'
import { findCities, weatherReport } from '../src/services.js'
import { openStore } from '../src/store.js'

const moscow = { label: 'Москва', latitude: 55.75, longitude: 37.62, timezone: 'Europe/Moscow' }
const omsk = { label: 'Омск', latitude: 55, longitude: 73.4, timezone: 'Asia/Omsk' }

test('диалог, независимая смена города и времени, рассылка после перезапуска', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weather-bot-'))
  const path = join(directory, 'weather.sqlite')
  let store = openStore(path)
  let time = new Date('2026-11-21T04:50:00Z')
  const messages = []
  function connect() {
    return createBot({
      store,
      now: () => time,
      send: async (chatId, text, keyboard) => messages.push({ chatId, text, keyboard }),
      findCities: async input => ({
        Москва: [moscow, { ...moscow, label: 'Москва, Тверская область' }],
        Омск: [omsk]
      })[input] ?? [],
      weatherReport: async (city, date) => `Погода: ${city.label} ${date}`
    })
  }
  let bot = connect()
  const chat = { id: 1, type: 'private' }
  const say = async text => {
    await bot.onMessage({ chat, text })
    return messages.at(-1)
  }
  try {
    assert.match((await say('/start')).text, /^Привет, я бот-погода/)
    assert.deepEqual(messages.at(-1).keyboard.keyboard, [['Найти город']])
    assert.equal((await say('Найти город')).text, 'введите ваш город')
    assert.match((await say('Москвва')).text, /^не смог найти город/)
    assert.match((await say('Москва')).text, /2\. Москва, Тверская область/)
    assert.match((await say('1')).text, /в формате XX:XX$/)
    for (const invalid of ['26:85', '8:00', '08:60', '24:00']) {
      assert.equal((await say(invalid)).text, 'время введено не верно, попробуйте еще раз')
    }
    assert.match((await say('08:00')).text, /^спасибо/)
    const configuredKeyboard = [['Узнать погоду сейчас'], ['Изменить город', 'Изменить время']]
    assert.deepEqual(messages.at(-1).keyboard.keyboard, configuredKeyboard)

    const originalSchedule = store.get(chat.id).schedule
    assert.equal((await say('Узнать погоду сейчас')).text, 'Погода: Москва 2026-11-21')
    assert.deepEqual(messages.at(-1).keyboard.inline_keyboard, [[{
      text: 'Open-Meteo', url: 'https://open-meteo.com/en/licence'
    }]])
    assert.deepEqual(store.get(chat.id).schedule, originalSchedule)
    assert.equal(store.delivered(chat.id, '2026-11-21'), false)

    const beforeDue = messages.length
    await bot.deliverDue()
    assert.equal(messages.length, beforeDue)
    time = new Date('2026-11-21T05:00:00Z')
    await bot.deliverDue()
    assert.equal(messages.at(-1).text, 'Погода: Москва 2026-11-21')
    assert.equal(messages.at(-1).keyboard.inline_keyboard[0][0].text, 'Open-Meteo')

    store.close()
    store = openStore(path)
    bot = connect()
    await bot.deliverDue()
    assert.equal(messages.length, beforeDue + 1)

    await say('Изменить время')
    assert.equal((await say('Узнать погоду сейчас')).text, 'Погода: Москва 2026-11-21')
    await say('09:15')
    assert.equal(store.get(chat.id).schedule.city.label, 'Москва')
    await say('Изменить город')
    await say('Омск')
    assert.equal(store.get(chat.id).schedule.time, '09:15')
    await say('/start')
    assert.equal(store.get(chat.id).schedule.city.label, 'Омск')

    time = new Date('2026-11-22T03:15:00Z')
    await bot.deliverDue()
    assert.equal(messages.at(-1).text, 'Погода: Омск 2026-11-22')
    assert.equal((await say('Узнать погоду сейчас')).text, 'Погода: Омск 2026-11-22')
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('после пропущенной минуты доставка повторяется после сбоя и приходит один раз', async () => {
  const store = openStore(':memory:')
  let time = new Date('2026-11-21T04:50:00Z')
  let attempts = 0
  const sent = []
  const bot = createBot({
    store,
    now: () => time,
    log: { warn() {} },
    send: async (_chatId, text) => sent.push(text),
    findCities: async () => [moscow],
    weatherReport: async () => {
      attempts++
      if (attempts === 1) throw new Error('Временный сбой')
      return 'Сводка'
    }
  })
  try {
    for (const text of ['Найти город', 'Москва', '08:00']) {
      await bot.onMessage({ chat: { id: 1, type: 'private' }, text })
    }
    time = new Date('2026-11-21T05:10:00Z')
    await bot.deliverDue()
    await bot.deliverDue()
    assert.equal(attempts, 1)
    time = new Date('2026-11-21T05:11:00Z')
    await bot.deliverDue()
    await bot.deliverDue()
    assert.equal(attempts, 2)
    assert.deepEqual(sent.filter(text => text === 'Сводка'), ['Сводка'])
  } finally {
    store.close()
  }
})

test('поиск без учёта регистра, отбрасывание опечатки и формат погодной сводки', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    if (url.pathname.endsWith('/search')) {
      assert.ok(['москва', 'москвва'].includes(url.searchParams.get('name')))
      return Response.json({ results: [{
        ...moscow, name: 'Москва', country: 'Россия', feature_code: 'PPLC'
      }] })
    }
    assert.equal(url.searchParams.get('timezone'), 'Europe/Moscow')
    assert.equal(url.searchParams.get('wind_speed_unit'), 'ms')
    return Response.json({
      current: { temperature_2m: -3.5, wind_speed_10m: 2, weather_code: 73 },
      daily: { time: ['2026-11-21'], precipitation_sum: [1.2] }
    })
  })
  const cities = await findCities('  МОСКВА ')
  assert.deepEqual(cities, await findCities('москва'))
  assert.deepEqual(await findCities('Москвва'), [])
  const report = await weatherReport(cities[0], '2026-11-21')
  assert.match(report, /-3,5 °C/)
  assert.match(report, /2 м\/с/)
  assert.match(report, /Сейчас: снег/)
  assert.match(report, /1,2 мм/)
  assert.doesNotMatch(report, /Источник|https?:/)
  assert.equal(fetch.mock.callCount(), 5)
})
