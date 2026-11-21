import { randomUUID } from 'node:crypto'

const greeting = 'Привет, я бот-погода, буду в выбранное тобой время отправлять сводки по погоде в твоем городе'
const askCity = 'введите ваш город'
const cityError = 'не смог найти город, проверьте, верно ли вы ввели название'
const askFirstTime = 'отлично, теперь напишите время в которое вы хотите получать погоду в формате XX:XX'
const askTime = 'напишите новое время в формате XX:XX'
const timeError = 'время введено не верно, попробуйте еще раз'
const confirmed = 'спасибо, в нужное время вы будете ежедневно получать прогноз'
const findCity = 'Найти город'
const changeCity = 'Изменить город'
const changeTime = 'Изменить время'
const weatherNow = 'Узнать погоду сейчас'
const weatherAttribution = {
  inline_keyboard: [[{ text: 'Open-Meteo', url: 'https://open-meteo.com/en/licence' }]]
}
const timePattern = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/
const formatters = new Map()

function localDateTime(now, timezone) {
  if (!formatters.has(timezone)) {
    formatters.set(timezone, new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }))
  }
  const fields = Object.fromEntries(formatters.get(timezone).formatToParts(now)
    .map(part => [part.type, part.value]))
  return { date: `${fields.year}-${fields.month}-${fields.day}`, time: `${fields.hour}:${fields.minute}` }
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function makeSchedule(city, time, now) {
  const local = localDateTime(now, city.timezone)
  return {
    city,
    time,
    firstDate: local.time <= time ? local.date : shiftDate(local.date, 1),
    revision: randomUUID()
  }
}

function homeKeyboard(schedule) {
  return {
    keyboard: schedule ? [[weatherNow], [changeCity, changeTime]] : [[findCity]],
    resize_keyboard: true
  }
}

export function createBot({ store, send, findCities, weatherReport, now = () => new Date(), log = console }) {
  const retryTimes = new Map()
  let lastPruneDate

  async function acceptCity(chatId, settings, city) {
    if (!settings.schedule) {
      store.save(chatId, { step: 'time', pendingCity: city })
      await send(chatId, `${city.label}\n${askFirstTime}`)
      return
    }
    const schedule = makeSchedule(city, settings.schedule.time, now())
    store.save(chatId, { schedule })
    await send(chatId, `Город изменён на ${city.label}. Время рассылки — ${schedule.time} по местному времени.`,
      homeKeyboard(schedule))
  }

  async function onMessage(message) {
    if (message?.chat?.type !== 'private' || typeof message.text !== 'string') return
    const chatId = message.chat.id
    const input = message.text.trim()
    const settings = store.get(chatId)
    const { schedule, step, choices, pendingCity } = settings

    if (/^\/start(?:@[a-z0-9_]+)?(?:\s|$)/i.test(input)) {
      store.save(chatId, { schedule })
      await send(chatId, greeting, homeKeyboard(schedule))
      return
    }
    if (input === weatherNow && schedule) {
      const { city } = schedule
      const { date } = localDateTime(now(), city.timezone)
      let report
      try {
        report = await weatherReport(city, date)
      } catch (error) {
        log.warn(error.message)
        await send(chatId, 'Погода временно недоступна. Попробуйте чуть позже.', homeKeyboard(schedule))
        return
      }
      await send(chatId, report, weatherAttribution)
      return
    }
    if (input === findCity || input === changeCity) {
      store.save(chatId, { schedule, step: 'city' })
      await send(chatId, askCity, homeKeyboard(schedule))
      return
    }
    if (input === changeTime && schedule) {
      store.save(chatId, { schedule, step: 'time' })
      await send(chatId, askTime, homeKeyboard(schedule))
      return
    }

    if (step === 'city') {
      if (choices && /^[1-8]$/.test(input) && choices[Number(input) - 1]) {
        await acceptCity(chatId, settings, choices[Number(input) - 1])
        return
      }
      let cities
      try {
        cities = await findCities(input)
      } catch (error) {
        log.warn(error.message)
        await send(chatId, 'Сервис поиска городов временно недоступен. Попробуйте ещё раз чуть позже.')
        return
      }
      if (!cities.length) {
        await send(chatId, cityError)
      } else if (cities.length === 1) {
        await acceptCity(chatId, settings, cities[0])
      } else {
        store.save(chatId, { ...settings, choices: cities })
        const options = cities.map((city, index) => `${index + 1}. ${city.label}`)
        await send(chatId, ['Нашёл несколько городов. Введите номер из списка или уточните название города.',
          ...options].join('\n'))
      }
      return
    }

    if (step === 'time') {
      if (!timePattern.test(input)) {
        await send(chatId, timeError)
        return
      }
      const newSchedule = makeSchedule(pendingCity ?? schedule.city, input, now())
      store.save(chatId, { schedule: newSchedule })
      await send(chatId, confirmed, homeKeyboard(newSchedule))
      return
    }

    await send(chatId, schedule
      ? `Рассылка для города ${schedule.city.label} в ${schedule.time} по местному времени.`
      : 'Нажмите «Найти город», чтобы настроить рассылку.', homeKeyboard(schedule))
  }

  async function deliverDue() {
    const utcDate = now().toISOString().slice(0, 10)
    if (lastPruneDate !== utcDate) {
      store.prune(shiftDate(utcDate, -7))
      lastPruneDate = utcDate
    }
    for (const [chatId, schedule] of store.active()) {
      const local = localDateTime(now(), schedule.city.timezone)
      if (local.date < schedule.firstDate || local.time < schedule.time ||
          store.delivered(chatId, local.date)) continue
      const retry = retryTimes.get(chatId)
      if (retry?.revision === schedule.revision && retry.at > now().getTime()) continue

      try {
        const report = await weatherReport(schedule.city, local.date)
        const current = store.get(chatId)
        if (current.paused || current.schedule?.revision !== schedule.revision ||
            localDateTime(now(), schedule.city.timezone).date !== local.date) continue
        await send(chatId, report, weatherAttribution)
        store.record(chatId, local.date)
        retryTimes.delete(chatId)
      } catch (error) {
        log.warn(error.message)
        const current = store.get(chatId)
        if (current.schedule?.revision !== schedule.revision) continue
        if (error.service === 'Telegram (sendMessage)' && error.code === 403) {
          store.save(chatId, { ...current, paused: true })
          retryTimes.delete(chatId)
          continue
        }
        const wait = Math.max(60, error.retryAfter ?? 0)
        retryTimes.set(chatId, { revision: schedule.revision, at: now().getTime() + wait * 1000 })
      }
    }
  }

  return { onMessage, deliverDue }
}
