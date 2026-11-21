import { mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { createBot } from './bot.js'
import { findCities, telegramApi, weatherReport } from './services.js'
import { openStore } from './store.js'

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (!token || !/^[0-9]+:[a-zA-Z0-9_-]+$/.test(token)) {
    throw new Error('Укажите токен от @BotFather в TELEGRAM_BOT_TOKEN. См. README.md.')
  }

  const telegram = telegramApi(token)
  const identity = await telegram('getMe')
  const webhook = await telegram('getWebhookInfo')
  if (webhook.url) {
    throw new Error('У бота уже настроен webhook. Используйте токен нового бота или отключите текущий webhook.')
  }
  await telegram('setMyCommands', { commands: [{ command: 'start', description: 'Начать работу с ботом' }] })

  mkdirSync('data', { recursive: true })
  const store = openStore('data/weather.sqlite')
  const bot = createBot({
    store, findCities, weatherReport,
    send: (chat_id, text, reply_markup) => telegram('sendMessage', {
      chat_id, text, reply_markup, link_preview_options: { is_disabled: true }
    })
  })
  console.log(`Бот @${identity.username} запущен. Откройте https://t.me/${identity.username} и нажмите «Старт».`)

  async function poll() {
    let offset
    while (true) {
      let updates
      try {
        updates = await telegram('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] })
      } catch (error) {
        if (error.code === 401 || error.code === 409) throw error
        console.warn(error.message)
        await delay(Math.max(5, error.retryAfter ?? 0) * 1000)
        continue
      }
      for (const update of updates) {
        try {
          await bot.onMessage(update.message)
        } catch (error) {
          console.warn(error.message)
        }
        offset = update.update_id + 1
      }
    }
  }

  async function schedule() {
    while (true) {
      await bot.deliverDue()
      await delay(5_000)
    }
  }

  await Promise.all([poll(), schedule()])
}

main().catch(error => {
  console.error(error.message)
  if (error.code === 409) console.error('Проверьте, что для этого токена запущен только один экземпляр бота.')
  process.exit(1)
})
