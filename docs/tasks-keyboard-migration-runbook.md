# Перенос команд на кнопки: сценарий исполнения

Это рабочий файл для исполнителя (Claude). Постановка задач и инварианты в [tasks-keyboard-migration.md](tasks-keyboard-migration.md). Здесь: порядок, точные файлы, решения, которые не пересматриваются, команды проверки и журнал. Шаги S1–S17 соответствуют задачам T1–T17.

---

## 0. Протокол сессии

1. Прочитать раздел 5 «Статус» и раздел 6 «Журнал». Взять первый невыполненный шаг.
2. Прочитать файлы из блока «Сначала прочитать» этого шага. Не полагаться на память о коде: между сессиями он мог измениться.
3. Выполнить шаг. Один шаг за один отчёт пользователю. Если шаг разбит на подшаги, отчитываться по подшагу.
4. Проверить:
   ```bash
   cd /Users/javlon/Desktop/2026/qadam_ai_products/ai-okk
   export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
   npx tsc --noEmit && npm run build >/dev/null && node --test tests/*.test.js 2>&1 | grep -E "^not ok|^# (tests|pass|fail)" && git diff --check
   ```
   Плюс проверки, перечисленные в самом шаге.
5. Обновить статус (раздел 5) и дописать журнал (раздел 6): дата, шаг, что сделано, что отложено.
6. Отчитаться пользователю: изменённые файлы, результаты проверок, что проверить в Telegram руками, «можно коммитить». Коммиты делает пользователь. Railway деплоит автоматически после пуша, миграции применяются при старте.

Правила, которые не нарушаются:
- Шаги этапа 0 и 1 не меняют поведение ни одной команды. Любое изменение поведения — отдельный шаг с явным описанием.
- Бот в тестах не поднимается: `src/bot/index.ts` создаёт экземпляр с polling при импорте. Всё, что тестируется, живёт в модулях, которые не импортируют `index.ts`.
- Модули, которые импортируются в тестах, не импортируют `src/queues/*`, `pbxHistory` и `callProcessingQueue` на верхнем уровне: BullMQ держит процесс тестов открытым. Нужна очередь — `await import()` внутри функции.
- Тексты для менеджеров на узбекском (латиница), как весь интерфейс бота. Тексты раздела «Феникс» и админских диагностик на русском, как сейчас. Эмодзи в новых текстах не использовать, выделение через HTML `<b>`.
- Проверить в Telegram сам не могу. На контрольных точках прошу пользователя пройти чек-лист из раздела 4 и жду его ответа, прежде чем идти дальше.

---

## 1. Зафиксированные решения

Чтобы не решать заново в каждой сессии.

**Структура файлов.**
```
src/bot/access.ts                  роли и права (S1)
src/bot/actions/types.ts           ActionContext, ActionDefinition, SectionId (S2)
src/bot/actions/registry.ts        defineAction, getAction, listActions, sections (S2)
src/bot/actions/dispatch.ts        runCommand / runFromButton / runFromCallback (S2)
src/bot/actions/reports.ts         /report /week /month /period /errors /my_stats /deal (S2a)
src/bot/actions/aiCoach.ts         /ask* /stop_ai (S2b)
src/bot/actions/admin.ts           /managers … /check_tg /sync_history /analyze_deal (S2c)
src/bot/keyboards/mainMenu.ts      reply-клавиатура по ролям (S4)
src/bot/keyboards/labelRouter.ts   текст кнопки → действие (S5)
src/bot/keyboards/menuCallbacks.ts обработчик callback с префиксом m: (S6)
src/bot/keyboards/managerPicker.ts постраничный выбор менеджера (S11)
src/bot/pendingInput.ts            ожидание ввода в Redis (S7)
src/bot/commandMenu.ts             setMyCommands по ролям (S3)
```
`src/bot/handlers/*.ts` остаются на месте; их `bot.onText` оборачиваются в действия реестра на месте, без переноса файлов.

**Роли.** `type BotRole = "admin" | "rop" | "teamlead" | "manager"`. `resolveAccess(telegramUserId)` возвращает `{ roles: Set<BotRole>, manager, isAdmin }`. Непривязанный пользователь: пустой набор ролей. Админ, который одновременно привязан как менеджер, получает обе роли; для `/report`, `/week`, `/month`, `/period` у него сохраняется текущее поведение: отчёт менеджера, не админский.

**Действие.**
```ts
interface ActionContext {
  bot: TelegramBot; chatId: number; userId: number; telegramUserId: string;
  access: Access; args: string[]; source: "command" | "button" | "callback";
  message?: TelegramBot.Message;
}
interface ActionDefinition {
  id: string;                       // snake_case, совпадает с командой без слэша
  section: SectionId;               // "reports" | "ai" | "team" | "company" | "phoenix" | "users" | "sync" | "help"
  roles: BotRole[];                 // пустой массив = все привязанные
  label: string;                    // подпись кнопки
  command?: { pattern: RegExp; usage: string; description: string };
  commandOnly?: boolean;            // в меню не выносится
  dangerous?: boolean;              // перед выполнением подтверждение
  run(ctx: ActionContext): Promise<void>;
}
```
Проверка роли выполняется в `dispatch`, один раз, для любого источника. `run` правам не доверяет и может проверять повторно, если так уже написано.

**Подписи кнопок.** Обычные слова, без эмодзи, уникальные в пределах всех ролей. Разделы: `Hisobotlar`, `AI-murabbiy`, `Jamoa`, `Kompaniya`, `Feniks`, `Foydalanuvchilar`, `Sinxronizatsiya`, `Yordam`. Служебная: `Bekor qilish`. Подпись не может состоять только из цифр, точек и пробелов и не может совпадать с датой `ДД.ММ.ГГГГ`. Тест в S5 это проверяет.

**Маршрутизация текста.** Кнопка ведёт себя как команда: выполняет действие и не трогает активные состояния. Исключение — `Bekor qilish`: снимает ожидание ввода и диалог дат. AI-сессия от кнопок не прерывается, как не прерывается сейчас командами.

**Callback.** Формат `m:<actionId>` или `m:<actionId>:<arg>`, `arg` — только `[A-Za-z0-9_-]`, итоговая строка не длиннее 64 байт. Открытие раздела: `m:sec:<sectionId>`. Страница выбора: `m:<actionId>:p<n>`. Подтверждение: `m:<actionId>:yes:<arg>` и `m:<actionId>:no`. Чужие префиксы (`tl_`, `rop_`, `admin_delete_team_`, `phx:`, токены карточек задач) обработчик `m:` не трогает.

**Дедупликация.** Сообщения: существующий `claimUpdate` (`bot:dedup:<chat>:<message>`). Callback: ключ `bot:cbq:<query.id>`, `EX 120 NX`, тем же способом. `answerCallbackQuery` вызывается ровно один раз на нажатие, даже при ошибке.

**Ожидание ввода.** Redis-ключ `bot:pending:<userId>`, значение JSON `{ kind, payload, createdAt }`, `EX 600`. API: `expectInput(userId, kind, payload)`, `takeInput(userId)`, `cancelInput(userId)`. Порядок в `bot.on("message")`: маршрутизатор подписей → ожидание ввода → существующие состояния в прежнем порядке.

**Флаг.** `BOT_KEYBOARDS_ENABLED` (включён при `true`, `1`, `yes`, `on`; по умолчанию выключен). `BOT_KEYBOARDS_ROLES` — необязательный список ролей для поэтапного включения; пусто — все. Выключен — клавиатуры не отправляются, маршрутизатор подписей и обработчик `m:` всё равно работают, чтобы старые кнопки в чатах не зависали.

---

## 2. Шаги

Формат: сначала прочитать → сделать → проверить → готово, когда → отчёт.

### S1. Единая проверка ролей (T1)

Сначала прочитать: `src/bot/index.ts` строки 100–150 (`getManager`, `isAdmin`, `requireManager`, `requireAdmin`), `isAdmin` в `handlers/adminRoles.ts`, `handlers/performance.ts`, `handlers/rop.ts`, `isRop` в `rop.ts`, проверки тимлида в `handlers/teamlead.ts`.

Сделать:
- Создать `src/bot/access.ts` с `resolveAccess`, `hasRole`, `requireRole(bot, msg, access, roles, denyText)`.
- Четыре `isAdmin` и проверки РОП/тимлид заменить на вызовы `access.ts`. Тексты отказов оставить прежними.
- Сохранить особый случай «админ и менеджер» в `/report`-группе: там условие `isAdmin && !manager` остаётся.

Проверить: общий прогон; `grep -rn "async function isAdmin" src/bot` даёт ноль; поведение каждой команды с отказом описано в отчёте одной строкой «текст не изменился».

Готово, когда: единственное место, где читаются `ADMIN_TELEGRAM_ID`, `botAdmin` и `manager.role` ради прав, — `access.ts`.

Отчёт: список заменённых мест. Тестировать в Telegram не нужно.

### S2. Реестр действий (T2)

Разбит на подшаги, каждый со своим отчётом. Общий приём для каждого `bot.onText`:
```ts
// было
bot.onText(/\/report$/, async (msg) => { ...тело... });
// стало
defineAction({ id: "report", section: "reports", roles: [], label: "Bugun", command: { pattern: /\/report$/, usage: "/report", description: "bugungi hisobot" }, run: runReport });
bot.onText(/\/report$/, (msg, match) => runCommand(bot, "report", msg, match));
```
`runCommand` делает `claimUpdate`, `resolveAccess`, проверку роли по реестру, собирает `ActionContext` и вызывает `run`. Тело команды переезжает в `run` без изменений; обращения к `msg` заменяются на `ctx.message`.

**S2a.** `src/bot/actions/{types,registry,dispatch}.ts` + перенос `/report`, `/week`, `/month`, `/period`, `/errors`, `/my_stats`, `/deal` в `actions/reports.ts`. `/my_stats` и `/team_stats` сейчас в `handlers/performance.ts` — обернуть на месте.
**S2b.** `/ask*`, `/stop_ai`, `/help`, `/start` в `actions/aiCoach.ts` и `actions/help.ts`. `/start` пока только регистрируется, клавиатура появится в S4.
**S2c.** Админские команды `index.ts` в `actions/admin.ts`. `/sync_history` и `/analyze_deal` используют очередь — импортировать лениво.
**S2d.** `handlers/performance.ts`, `handlers/adminRoles.ts`, `handlers/rop.ts`, `handlers/teamlead.ts`: обернуть `bot.onText` на месте. Обработчики `callback_query` в этих файлах не трогать.
**S2e.** Мета-тест `tests/botActionRegistry.test.js`: загружает `dist/bot/actions/registry` и все модули действий; проверяет, что идентификаторы уникальны, что у каждого действия с `command` паттерн компилируется, и что число действий с `command` равно числу `bot.onText` в `src/bot` (считать через чтение исходников, как в тесте «every amoCRM axios entrypoint»). Исключения перечисляются в тесте явно.

Проверить после каждого подшага: общий прогон; число обработчиков команд не меняется: `bot.onText(` по `src/bot` без `actions/dispatch.ts` плюс идентификаторы во всех `registerCommandActions(bot, [...])` равно 59 (базовое число до S2); тест реестра импортируется без зависания.

Готово, когда: `index.ts` не содержит тел команд, только регистрацию, обработчик сообщений и обработчик `/start`.

Отчёт: после S2e попросить пользователя прогнать по одной команде каждой роли из раздела 4, чек-лист «команды». Это первая контрольная точка.

### S3. Меню команд Telegram (T3)

Сначала прочитать: `actions/registry.ts`, документацию `setMyCommands` в типах `node-telegram-bot-api` (`BotCommandScope`).

Сделать: `src/bot/commandMenu.ts` с `syncCommandMenu(bot, chatId, access)`: собирает команды из реестра по ролям (только те, у которых есть `command` и нет `commandOnly`), описание ≤ 256 символов, имя ≤ 32 символов в нижнем регистре. Область `{ type: "chat", chat_id }`. Вызывать при `/start`, после привязки кода, после `set_role` и смены тимлида. Для области по умолчанию — набор менеджера.

Проверить: общий прогон; юнит-тест, что для каждой роли набор не пуст и не содержит `commandOnly`.

Отчёт: попросить пользователя набрать «/» в чате под каждой ролью и сверить списки.

### S4. Главное меню (T4)

Сначала прочитать: `actions/registry.ts`, `/start` в `actions/help.ts`, обработчик привязки кода в `index.ts` (State 1), `set_role` в `handlers/adminRoles.ts`.

Сделать: `keyboards/mainMenu.ts` — `buildMainMenu(access)` возвращает `ReplyKeyboardMarkup` с разделами по ролям, `resize_keyboard: true`, `is_persistent: true`. Разделы в порядке: Hisobotlar, AI-murabbiy, затем Jamoa (тимлид), Kompaniya (РОП, админ), Feniks (РОП, админ), Foydalanuvchilar и Sinxronizatsiya (админ), Yordam. Отправлять при `/start`, по `Yordam`, после привязки, после смены роли — в чат того, чью роль изменили. За флагом `BOT_KEYBOARDS_ENABLED`.

Проверить: общий прогон; тест-снимок состава меню для четырёх ролей и для «админ и менеджер».

Отчёт: скриншоты меню от пользователя для четырёх ролей (контрольная точка 2, чек-лист «меню»).

### S5. Маршрутизатор подписей (T5)

Сначала прочитать: `bot.on("message")` в `index.ts` целиком, `keyboards/mainMenu.ts`.

Сделать: `keyboards/labelRouter.ts` — `resolveLabel(text)` → `{ kind: "section", id } | { kind: "action", id } | { kind: "cancel" } | null`. Вставить в начало `bot.on("message")` сразу после `claimUpdate`. Раздел → отправить inline-клавиатуру раздела (из S6, временно текстовый список команд, если S6 ещё нет). Действие → `runFromButton`. `cancel` → снять `periodState` и ожидание ввода, ответить «Bekor qilindi». Остальное — существующая логика без изменений.

Проверить: общий прогон; тест уникальности подписей и их несовпадения с шаблонами `^\d{6}$`, `^\d{2}\.\d{2}\.\d{4}$`, `^[\d\s.]+$`.

Готово, когда: нажатие любой кнопки во время ввода дат, кода или AI-сессии выполняет действие кнопки, а состояние остаётся как было.

### S6. Обработчик inline-кнопок (T6)

Сначала прочитать: `handlers/performance.ts` обработчик `phx:` (образец снятия кнопок и `answerCallbackQuery`), `handlers/callTaskReview.ts`.

Сделать: `keyboards/menuCallbacks.ts` — `registerMenuCallbackHandler(bot)`; разбор `m:`; дедупликация `bot:cbq:<id>`; проверка роли; `m:sec:<id>` рисует inline-клавиатуру раздела из реестра по ролям; `m:<action>` → `runFromCallback`; после терминального действия `editMessageReplyMarkup` с пустой клавиатурой. Зарегистрировать в `index.ts` рядом с остальными `register*`. Любая ошибка → `answerCallbackQuery` с коротким текстом и `console.error` через `summarizeError`.

Проверить: общий прогон; тест разбора `m:` строк, включая отказ на длину > 64 и недопустимые символы; тест, что ни один существующий префикс не начинается с `m:`.

### S7. Ожидание ввода (T7)

Сначала прочитать: `periodState` и State-блоки в `index.ts`, `redisConnection` в `src/config/queue.ts` (внимание: импорт очереди; для тестов хранилище принимает клиент Redis параметром).

Сделать: `src/bot/pendingInput.ts` с хранилищем на интерфейсе `{ set, get, del }`; реализация на `redisConnection` подключается в `index.ts`. Виды ввода: `deal_id`, `lead_id`, `telegram_id`, `plan_amount`, `task_due`, `period_from`, `period_to`. Перевести `periodState` на `period_from`/`period_to`, удалив `Map`. Запрос значения отправляется с inline-кнопкой `m:cancel` и подсказкой формата.

Проверить: общий прогон; тест хранилища на фиктивном клиенте: просроченный ввод не возвращается, повторный `expect` перезаписывает, `cancel` очищает.

Готово, когда: диалог `/period` переживает перезапуск процесса (проверить рассуждением по коду и тестом, не вручную).

### S8. Разделы «Отчёты» и «AI-murabbiy» (T8)

Сделать: inline-клавиатура раздела `reports`: Bugun, Hafta, Oy, Davr, Xatolar, Mening statistikam, Bitim. `Bitim` → ожидание `deal_id` → существующий `run` действия `deal` с `args=[id]`. Раздел `ai`: Boshlash (30 kun), Kun, Hafta, Oy; `To'xtatish` показывается, если у пользователя активна сессия. Админ без привязки получает отчёты в админском режиме через тот же `run`, что и команды.

Проверить: общий прогон; тест состава раздела по ролям.

Отчёт: контрольная точка 3, чек-лист «отчёты» для менеджера и админа.

### S9. Раздел «Команда» (T9)

Сделать: раздел `team` для тимлида: Jamoam, Reyting, Xatolar, Qo'shish, Chiqarish, Menejer kartasi, AI-savol. Последние четыре вызывают те же функции, что команды `/team_add`, `/team_remove`, `/team_manager`, `/ask_manager`; их существующие inline-потоки `tl_*` не меняются.

Проверить: общий прогон. Отчёт: пользователь проходит чек-лист «команда» под тимлидом.

### S10. Раздел «Компания» (T10)

Сделать: раздел `company` для РОПа и админа: Jamoalar, Umumiy reyting, Xatolar, Jamoa reytingi, Jamoa xatolari, Menejer kartasi, AI-savol, Kompaniya hisoboti (`team_stats`). Потоки `rop_*` не меняются.

Проверить: общий прогон. Отчёт: чек-лист «компания» под РОПом.

### S11. Планы, рейтинг, статус звонков (T11)

Сначала прочитать: `/set_plan`, `/plans`, `/rating_*`, `/call_status`, `/sync_stages` в `handlers/performance.ts`; выбор менеджера в `handlers/rop.ts` как образец.

Сделать: `keyboards/managerPicker.ts` — `sendManagerPicker(ctx, actionId, page)`: активные менеджеры, по 8 на страницу, подпись через `formatManagerDisplayName`, кнопки «‹ ›», callback `m:<action>:<managerId>` и `m:<action>:p<n>`. Цепочка `set_plan`: выбор менеджера → ожидание `plan_amount` → inline выбор месяца (текущий, следующий) → вызов `run` с `args=[amoUserId, amount, month]`. `plans`: месяц inline. `rating_off`/`rating_on`: выбор менеджера → подтверждение `m:rating_off:yes:<id>`. `call_status`: inline 1, 3, 7, 14. Все цепочки заканчиваются вызовом существующих `run` с теми же аргументами, что у команд.

Проверить: общий прогон; тест разбиения на страницы и формата callback; тест, что цепочка `set_plan` передаёт в `run` ровно те аргументы, что команда.

Отчёт: контрольная точка 4, чек-лист «планы» под РОПом.

### S12. Раздел «Феникс» (T12)

Сделать: раздел `phoenix` для РОПа и админа: Holat (`inactivity_status`), Kalit (`inactivity_switch`), Limit (один экран: текущее состояние и кнопки `m:inactivity_limit_on`, `m:inactivity_limit_off`), Yoqish (`inactivity_on`, далее существующее `phx:` подтверждение), To'xtatish (`inactivity_off` с подтверждением `m:inactivity_off:yes`), Bitim bo'yicha (ожидание `lead_id` → `inactivity_lead`). Тексты раздела остаются русскими, как сами команды.

Проверить: общий прогон; тест, что `inactivity_off` помечен `dangerous` и без `yes` не выполняется.

Отчёт: чек-лист «Феникс». Напомнить пользователю, что `To'xtatish` реально останавливает переводы.

### S13. Разделы «Пользователи» и «Синхронизация» (T13)

Сначала прочитать: `actions/admin.ts`, `handlers/adminRoles.ts`, `callTaskReviewNotifications.ts` и `handlers/callTaskReview.ts` (карточка AI-задачи).

Сделать: раздел `users`: Menejerlar, amoID ro'yxati, Adminlar, Jamoalar ro'yxati, Kod qayta berish (выбор менеджера → подтверждение), Admin qo'shish (ожидание `telegram_id`), Adminni olib tashlash (ожидание `telegram_id` → подтверждение), Rol berish (выбор из привязанных пользователей → inline роль → подтверждение), Tim-lid tayinlash, Jamoaga qo'shish (два выбора), Jamoadan chiqarish, Jamoani o'chirish (выбор команды → существующее `admin_delete_team_*`), Bitimni tahlil qilish (ожидание `deal_id`). Раздел `sync`: PBX menejerlar, Qo'ng'iroqlar tarixi. На карточке AI-задачи добавить кнопку «Muddatni ko'rsatish»: ожидание `task_due` с токеном в payload → тот же код, что `/call_task_time`. Отладочные `test_restrict`, `test_restore`, `check_tg` остаются `commandOnly`.

Проверить: общий прогон; тест, что все `dangerous` действия раздела требуют `yes`.

Отчёт: контрольная точка 5, чек-лист «админ».

### S14. Остальные состояния в Redis (T14)

Сделать: `aiSessions`, `supervisorAiSessions`, `roleFlowState`, `teamLeadManageFlowState` на хранилище из S7 с собственными ключами и TTL, равными текущим неявным (для AI-сессий — 2 часа, записать в код как константу). Историю AI-сессии в Redis не класть: держать идентификатор сессии в БД, как у `/coach`, и подгружать по нему.

Проверить: общий прогон; тесты на сериализацию и истечение.

### S15. Помощь и документация (T15)

Сделать: `/help` и `Yordam` генерируются из реестра: разделы с кнопками, затем команды с аргументами, затем `commandOnly`. Три захардкоженных блока help в `index.ts` удалить. Обновить `admin-commands.md`: колонка «как кнопками».

Проверить: общий прогон; тест, что help для каждой роли содержит все её действия.

### S16. Тесты (T16)

Сделать: закрыть пропуски против списка в T16 задачника. Отдельно: тест «вызов действия с чужой ролью отвечает отказом и не вызывает `run`» для каждого действия с непустым `roles`.

### S17. Выкат (T17)

Сделать: флаг `BOT_KEYBOARDS_ENABLED` читается в одном месте; лог нажатий `[BotMenu] action=<id> role=<r> source=<s>`; при выключенном флаге `/start` отправляет `remove_keyboard`. Порядок включения: пользователь выставляет флаг в Railway, сначала проверяет под админом, затем РОП и тимлиды, затем менеджеры. Инструкция пользователю в отчёте.

---

## 3. Что проверяю сам после каждого шага

- Общий прогон из протокола.
- Число обработчиков команд (должно быть 59 до S2e включительно; `grep` по многострочным спискам ошибается, поэтому считать так):
  ```bash
  python3 - <<'PY'
  import re, pathlib
  src = {p: p.read_text() for p in pathlib.Path("src/bot").rglob("*.ts")}
  ontext = sum(len(re.findall(r"bot\.onText\(", s)) for p, s in src.items() if p.name != "dispatch.ts")
  ids = [i for s in src.values() for m in re.finditer(r"registerCommandActions\(bot, \[(.*?)\]\)", s, flags=re.S) for i in re.findall(r'"([a-z_]+)"', m.group(1))]
  print("onText:", ontext, "registered:", len(ids), "total:", ontext + len(ids), "duplicates:", sorted({i for i in ids if ids.count(i) > 1}))
  PY
  ```
- `grep -rn "console.error([^)]*, \(err\|error\|e\))" src/bot` не показывает сырых дампов: только `summarizeError`.
- Новые модули в `tests/` импортируются без зависания (тест завершается сам).
- В `git status` нет лишних файлов, `git diff --check` чистый.
- Ни одна строка из `docs/admin-commands.md`, описывающая команды, не стала ложной.

---

## 4. Чек-листы для ручной проверки пользователем

**Команды (после S2e).** Под менеджером: `/report`, `/period` с двумя датами, `/ask` и один вопрос, `/stop_ai`, `/deal <id>`. Под тимлидом: `/team_stats`, `/team_add` до конца потока. Под РОПом: `/set_plan`, `/plans`, `/call_status 3`, `/inactivity_status`. Под админом: `/managers`, `/analyze_deal <id>`, `/set_role`. Ожидание: всё отвечает как до изменений.

**Меню (после S4).** `/start` под каждой ролью: состав разделов совпадает с таблицей ролей из задачника. Непривязанный пользователь клавиатуры не видит.

**Отчёты (после S8).** Кнопками: Bugun, Davr с вводом дат, Bitim с вводом ID, AI-murabbiy → Hafta → вопрос → To'xtatish. Отдельно: нажать Bugun посреди ввода дат — отчёт приходит, ввод дат остаётся ждать.

**Команда, компания, планы, Феникс, админ (после S9–S13).** Каждое действие раздела один раз кнопкой; для опасных — проверить, что «Нет» ничего не делает, а повторное нажатие уже обработанной кнопки отвечает «Allaqachon bajarilgan».

---

## 5. Статус

| Шаг | Состояние | Примечание |
|---|---|---|
| S1 | готов | `src/bot/access.ts`; проверка в Telegram не требовалась |
| S2a | готов | реестр + `/report` `/week` `/month` `/period` `/errors` `/deal` `/my_stats` `/team_stats` |
| S2b | готов | `/start` `/help` `/ask*` `/stop_ai` в `actions/help.ts`, `actions/aiCoach.ts` |
| S2c | готов | 12 админских команд в `actions/admin.ts`; тяжёлые сервисы импортируются лениво |
| S2d | готов | 34 команды в `handlers/*.ts` обёрнуты на месте; прямых `bot.onText` больше нет |
| S2e | ждёт проверки пользователя | контрольная точка 1: чек-лист «Команды» из раздела 4 |
| S3 | ждёт проверки пользователя | меню «/» по ролям: набрать «/» под каждой ролью и сверить списки |
| S4 | ждёт проверки пользователя | контрольная точка 2: включить `BOT_KEYBOARDS_ENABLED=true`, `/start` под каждой ролью, скриншоты; кнопки заработают только после S5 |
| S5 | готов | маршрутизатор подписей; проверяется вместе с контрольной точкой 2 |
| S6 | готов | обработчик `m:`; разделы теперь inline-клавиатуры; опасные действия с подтверждением |
| S7 | готов | ожидание ввода в Redis; `/period` переведён; `periodState` удалён |
| S8 | ждёт проверки пользователя | контрольная точка 3: чек-лист «Отчёты» под менеджером и админом |
| S9 | ждёт проверки пользователя | раздел `Jamoa`; чек-лист «команда» под тимлидом |
| S10 | ждёт проверки пользователя | раздел `Kompaniya`; чек-лист «компания» под РОПом |
| S11 | ждёт проверки пользователя | контрольная точка 4: чек-лист «планы» под РОПом |
| S12 | ждёт проверки пользователя | раздел `Feniks`; чек-лист «Феникс» под РОПом или админом |
| S13 | ждёт проверки пользователя | контрольная точка 5: чек-лист «админ» |
| S14 | готов | AI-сессии и потоки в Redis; проверить, что AI-сессия переживает деплой |
| S15 | готов | `/help` и «Yordam» генерируются из реестра; в `admin-commands.md` раздел 2а с таблицей кнопок |
| S16 | готов | права по каждому действию, инварианты кнопок, путь команды через диспетчер |
| S17 | готов | поэтапное включение через `BOT_KEYBOARDS_ROLES`, лог действий, порядок включения и откат в `admin-commands.md` |

Состояния: не начат → в работе → ждёт проверки пользователя → готов.

---

## 6. Журнал

Формат записи: `ГГГГ-ММ-ДД, шаг: что сделано; что отложено; число bot.onText до/после`.

- 2026-10-17, план: сценарий написан, код не менялся.
- 2026-10-17, S1: создан `src/bot/access.ts` (`isBotAdmin`, `findLinkedManager`, `resolveAccess`, `rolesOf`, `hasRole`, `isLinkedAs`); четыре копии `isAdmin` и три поиска привязанного менеджера удалены из `index.ts`, `performance.ts`, `rop.ts`, `adminRoles.ts`, `teamlead.ts`; тексты отказов не менялись. Намеренно оставлено вне `access.ts`: проверки «нельзя добавить или снять суперадмина» и вывод списка в `/admins` (бизнес-правила, не права), проверка роли целевого менеджера в `adminRoles.ts:110` (валидация аргумента). Тест `tests/botAccess.test.js`. bot.onText до/после: 59/59. Следующий шаг S2a.
- 2026-10-17, S2a: созданы `src/bot/actions/{types,registry,dispatch,reports,deal}.ts`, `src/bot/dedupe.ts` (`claimUpdate`/`claimCallback` с ленивым Redis), `src/bot/reportText.ts`; `periodState` переехал в `src/bot/state.ts`. Из `index.ts` вырезаны секции «Criteria helpers», «Build report», `/report` `/week` `/month`, `/period`, `/errors`, «Deal dossier» (1868 → 1331 строк); в `performance.ts` `/my_stats` и `/team_stats` стали действиями, `sendPerformance` принимает `chatId`. Регистрация через `registerCommandActions`. Обработчики до/после: 59/59 (50 onText + 9 в реестре). Тест `tests/botActions.test.js`. Отличия, принятые осознанно: для неавторизованного пользователя отказ теперь приходит без предварительного «⏳ Hisobot tuzilmoqda...»; `/my_stats` и `/team_stats` получили дедупликацию `claimUpdate`, которой у них не было. Тексты отказов и ответов не менялись. Следующий шаг S2b.
- 2026-10-18, S2b: `actions/aiCoach.ts` (разбор `/ask`, системный промпт, действия `ask` и `stop_ai`; клиент Gemini импортируется лениво), `actions/help.ts` (`start`, `help`, тексты блоков как константы, `helpTextFor`, `startReply`), баррель `actions/index.ts`; `awaitingCode` и `aiSessions` переехали в `state.ts`; `requireManager` из `index.ts` удалён как неиспользуемый (`requireAdmin` остался для S2c). `index.ts`: 1331 → 909 строк. Обработчики: 46 onText + 13 в реестре = 59. Тесты в `tests/botActions.test.js`. Замечено, не исправлялось: паттерн `/\/ask(.*)/` не заякорен и срабатывает также на `/ask_manager` тимлида, запуская AI-сессию с вопросом «manager» параллельно с потоком тимлида; это поведение существовало до переноса, исправление отдельным решением в S8. Следующий шаг S2c.
- 2026-10-18, S2c: `actions/admin.ts` с 12 действиями (`sync_managers`, `sync_history`, `managers`, `manager_ids`, `admins`, `add_admin`, `remove_admin`, `reset_code`, `analyze_deal`, `check_tg`, `test_restrict`, `test_restore`); `amocrm`, `pbxHistory`, очередь, `managerSync`, `amoRights` импортируются внутри `run`; тест проверяет, что загрузка реестра не подтягивает BullMQ, очередь, `pbxHistory` и `amocrm`. `check_tg`, `test_restrict`, `test_restore` помечены `commandOnly`; `remove_admin`, `reset_code`, `test_restrict` помечены `dangerous`. Из `index.ts` удалены 12 секций и `requireAdmin`; осталось 324 строки: инициализация, обработчик свободного текста, регистрация. Обработчики: 34 onText + 25 в реестре = 59. Следующий шаг S2d.
- 2026-10-18, S2d: все `bot.onText` в `performance.ts` (13), `adminRoles.ts` (6), `rop.ts` (7), `teamlead.ts` (7), `callTaskReview.ts` (1) заменены на `defineAction` в той же области видимости (внутри `register*Handlers`, чтобы сохранить замыкания вроде ленивого сервиса сверки); тела не менялись, кроме `match![N]` → `ctx.args[N-1]`; регистрация через `registerCommandActions` в конце каждой функции. `denyText` теперь может быть функцией от `Access`: тимлид получает прежние два текста («Sizda TeamLead huquqi yo'q» / «Hisobingiz deaktiv qilingan»). `/rating_off|on` стало одним действием `rating_toggle`, `/set_plan` без аргументов — `set_plan_usage` (commandOnly), `/call_task_time` — `call_task_time` (roles [], проверка рецензента осталась в теле). Подписи всех действий и разделов сделаны уникальными, тест это проверяет (`AI-murabbiyni boshlash/to'xtatish`, `Start`, `Buyruqlar ro'yxati`, `Feniks …`, `… (tanlash)`). Обработчики: 0 onText + 59 в реестре. Принятое отличие: у команд из `handlers/*` появилась дедупликация `claimUpdate`. Внешний вид: тела внутри `run` остались с прежним отступом в 4 пробела, выравнивание при S8–S13. Следующий шаг S2e.
- 2026-10-18, S2e: `tests/botActionRegistry.test.js`: загружает баррель и пять модулей обработчиков с фиктивным ботом; проверяет отсутствие `bot.onText` вне диспетчера, равенство множества зарегистрированных идентификаторов множеству действий с `command`, отсутствие дублей, `EXPECTED_COMMAND_COUNT = 59`, что число паттернов, зарегистрированных обработчиками в рантайме, равно их спискам в исходниках, что каждый паттерн нацелен на слэш-команду, уникальность подписей и отсутствие BullMQ/очереди/`pbxHistory`/`amocrm` в `require.cache`. Для этого `fetchAllPipelines` в `performance.ts` стал ленивым импортом. Этап S2 закрыт, код ждёт контрольной точки 1 (ручная проверка команд по ролям). Следующий шаг после подтверждения: S3.
- 2026-10-18, S3 (начат до подтверждения контрольной точки 1 по слову пользователя; поведение команд не меняет): `src/bot/commandMenu.ts` — `commandMenuFor(access)` строит список из реестра (действия с `command`, без `commandOnly`, по `isAllowed`; порядок по разделам; непривязанный видит только `start` и `help`), `syncCommandMenu` ставит область `{type:"chat"}` и глушит ошибки Telegram, `installDefaultCommandMenu` ставит набор менеджера в область по умолчанию при старте. В `ActionCommand` добавлено поле `menu` для действий, покрывающих несколько команд: `ask` (ask, ask_kun, ask_hafta, ask_oy), `rating_toggle` (rating_off, rating_on), `inactivity_limit` (три варианта). Синхронизация вызывается в `/start`, после успешной привязки кода, после `set_role` (по Telegram ID) и `set_teamlead` (по привязке менеджера). Тесты `tests/botCommandMenu.test.js`. Ограничение: после `add_to_team`/`remove_from_team` меню не обновляется, роль при этом не меняется. Следующий шаг S4.
- 2026-10-18, S4: `src/bot/keyboards/mainMenu.ts` — `keyboardsEnabled()` (строго `"true"`), `mainMenuSections(access)` (раздел виден, если роль подходит и в нём есть хотя бы одно доступное действие), `buildMainMenu` (по две кнопки в ряд, `Yordam` последней строкой, `resize_keyboard`, `is_persistent`), `mainMenuMarkup` (при выключенном флаге или без ролей — `remove_keyboard`), `sendMainMenu`, `refreshMainMenuForTelegramUser/ForManager` (только при включённом флаге, иначе сообщений не шлют). Клавиатура прикреплена к ответу `/start`, к сообщению об успешной привязке кода и к уведомлению о смене роли после `set_role`/`set_teamlead` (текст `ROLE_CHANGED_TEXT`). Снимки раскладки для менеджера, тимлида, РОПа, админа и «админ + тимлид» в `tests/botMainMenu.test.js`. В `docs/admin-commands.md` добавлена переменная `BOT_KEYBOARDS_ENABLED`. Пока флаг выключен, единственное внешнее отличие — `/start` и привязка шлют `remove_keyboard`, что без клавиатуры незаметно. При включённом флаге до S5 нажатия кнопок уходят в обработчик свободного текста и игнорируются. Следующий шаг S5.
- 2026-10-18, S4 (доработка): пользователь выставил `BOT_KEYBOARDS_ENABLED=1`, а флаг принимал только `true`; теперь принимаются `true`, `1`, `yes`, `on` без учёта регистра. Тест и документация обновлены.
- 2026-10-18, S5: `src/bot/keyboards/labelRouter.ts` — `resolveLabel` (точное совпадение после `trim` с подписями разделов, действий без `commandOnly` и `CANCEL_LABEL = "Bekor qilish"`), `renderSectionText` (временный текстовый вид раздела: подпись — команда, HTML-экранирование), `handleLabelHit` (раздел `help` шлёт справку с клавиатурой; остальные разделы — текстовый список; действие — `runFromButton`; отмена снимает `periodState`). Вставлен в `bot.on("message")` сразу после `claimUpdate`, до всех состояний. В `dispatch.ts`: `runFromButton` (без повторного `claimUpdate`), `requiredArgCount(usage)` и страховка в `execute`: нажатие кнопки на действии с обязательными `<аргументами>` без них отвечает `Foydalanish: …`, а не запускает `run`. Тесты `tests/botLabelRouter.test.js`: разрешение подписей, исключение `commandOnly`, несовпадение подписей с кодом/датой/ID сделки, вид раздела по ролям, подсчёт аргументов, страховка, отмена. Маршрутизатор работает независимо от флага, чтобы старые кнопки в чатах не зависали. Следующий шаг S6.
- 2026-10-18, S6: `src/bot/keyboards/menuCallbacks.ts` — `parseMenuCallback`/`sectionCallback`/`actionCallback`/`confirmCallback` (формат `m:<action>[:<arg>]`, `m:sec:<section>`, `m:<action>:yes[:<arg>]`, `m:<action>:no`; части `[A-Za-z0-9_-]`, ≤ 64 байт), `sectionKeyboard` (по две кнопки в ряд), `confirmKeyboard` (Ha / Yo'q), `registerMenuCallbackHandler(bot, deps)` с подменяемыми `claimCallback`, `claimCallbackAction`, `resolveAccess`. Поток: чужие префиксы игнорируются; дедупликация по `query.id`; ответ на нажатие ровно один раз через `finally`; раздел — `editMessageText` с клавиатурой раздела; опасное действие без решения — отдельное сообщение с подтверждением, `no` — «Bekor qilindi», `yes` — снятие кнопок с карточки и запуск; обычное действие — блокировка той же кнопки на том же сообщении на 5 с (`claimCallbackAction`, ответ «Bajarilmoqda…»), меню раздела кнопки не теряет; ошибка — лог через `summarizeError`. В `dispatch.ts` добавлен `runFromCallback`. `labelRouter`: нажатие раздела с reply-клавиатуры шлёт заголовок раздела с inline-клавиатурой, текстовый список убран. Зарегистрирован в `index.ts`. Тесты `tests/botMenuCallbacks.test.js` (12) и обновлённый `botLabelRouter.test.js`. Решение, отличное от плана: после обычного действия клавиатура раздела не снимается, иначе раздел пришлось бы открывать заново после каждого нажатия; защита от двойного нажатия — 5-секундная блокировка. Следующий шаг S7.
- 2026-10-18, S7: `src/bot/pendingInput.ts` — `createPendingInputService(store, now)` с `expect`/`lookup`/`take`/`cancel`, ключ `bot:pending:<userId>`, логический срок 10 минут (`PENDING_INPUT_TTL_MS`), запись хранится час (`PENDING_INPUT_KEEP_SECONDS`), чтобы поздний ответ получил «Vaqt tugadi. Tugmani qaytadan bosing.» вместо неверной трактовки; битая запись удаляется молча; Redis-хранилище с ленивым импортом очереди. `src/bot/inputHandlers.ts` — `defineInputHandler(kind, fn)`, `handlePendingInput(bot, msg, lookup, service)`; неизвестный вид ввода сбрасывается с ошибкой в лог. В `bot.on("message")` шаг «ответ на вопрос бота» стоит сразу после маршрутизатора подписей, до кода активации и остальных состояний. `/period` переведён: действие делает `expect(period_from, {adminMode})`, обработчики `period_from`/`period_to` в `actions/reports.ts` повторяют прежнюю логику (неверная дата оставляет вопрос открытым, обратный порядок дат завершает диалог), под обоими запросами inline-кнопка `Bekor qilish` (`m:cancel`). `periodState` удалён из `state.ts`. `menuCallbacks` понимает `m:cancel` (сбрасывает ожидание, переписывает запрос на «Bekor qilindi.»), `labelRouter` при `Bekor qilish` вызывает `pendingInput.cancel`; оба принимают зависимости для тестов. Тесты `tests/botPendingInput.test.js` (6), обновлены `botLabelRouter` и `botMenuCallbacks`. Отличие от плана: срок жизни проверяется по `createdAt`, а не по TTL ключа, иначе «время вышло» было бы неотличимо от «ничего не ждём». Следующий шаг S8.
- 2026-10-18, S8: общий механизм вопроса: у действия поле `input: { kind, prompt }`; `execute` при запуске не из команды и без обязательных аргументов делает `pending.expect(userId, kind, { action })` и шлёт вопрос с `Bekor qilish`; `actions/inputFlows.ts` — обработчики `deal_id`, `lead_id`, `telegram_id` (проверка формата как у команды, при ошибке вопрос остаётся открытым), `dispatchAnswer` запускает действие с ответом через `runFromInput` (source `input`), а для `dangerous` сначала шлёт подтверждение со значением в кнопке (`m:<id>:yes:<value>`); `menuCallbacks` не подтверждает заранее действие, которому ещё предстоит спросить значение. Вопросы объявлены у `deal`, `analyze_deal`, `inactivity_lead`, `add_admin`, `remove_admin` (последние четыре раньше плана S12/S13, механизм один и тот же). Кнопка отмены вынесена в `keyboards/cancel.ts`, чтобы не было цикла `dispatch ↔ menuCallbacks`. `ActionDefinition` получил `variants` (несколько кнопок одного действия с разными аргументами) и `showWhen` (условная видимость в клавиатуре раздела); `sectionKeyboard(access, section, userId)`. Раздел `ai`: `Boshlash (30 kun)`, `Kun`, `Hafta`, `Oy` как варианты `ask`; `AI-murabbiyni to'xtatish` показывается только при активной сессии. Шаблон `/ask` заякорен: `/^\/ask((?:_(?:kun|hafta|oy))?(?:\s[\s\S]*)?)$/`; изменение поведения, принятое осознанно: `/ask_manager` больше не запускает параллельно AI-сессию, произвольные префиксы вроде `/askanything` не срабатывают. `configureDispatch` принимает также `resolveAccess` для тестов. Тесты `tests/botInputFlows.test.js` (6), дополнены `botActions` и `botMenuCallbacks`. Следующий шаг S9.
- 2026-10-18, S9: раздел `team` собирается автоматически из семи действий тимлида (S2d), ничего в потоках `tl_*` не менялось. Найдена и исправлена ошибка, общая для всех разделов из `handlers/*`: тела действий берут пользователя из `msg.from` (11 мест, плюс ключ `teamLeadManageFlowState`), а при нажатии inline-кнопки `query.message.from` — это бот; теперь `menuCallbacks` передаёт действию `message: { ...message, from: query.from }`. Тесты: `tests/botSections.test.js` (состав и видимость раздела `team`, отсутствие обязательных аргументов), в `botMenuCallbacks` проверка, что действие видит нажавшего как автора сообщения. Следующий шаг S10.
- 2026-10-18, S10: раздел `company` для РОПа и админа: семь действий РОПа (`order: 10`) идут первыми, затем `sync_stages`, `rating_toggle`, `rating_list`, `call_status`, `set_plan`, `plans`. В `ActionDefinition` добавлено поле `order`, `visibleActions` сортирует по нему стабильно (по умолчанию 100): раскладка раздела больше не зависит от порядка регистрации обработчиков, который в тестах отличается от продакшена. Подписи `rop_team_rating`/`rop_team_mistakes` переименованы в «Jamoa bo'yicha reyting» / «Jamoa bo'yicha xatolar». Потоки `rop_*` не менялись. Отклонение от плана: `team_stats` («Jamoa hisoboti») остаётся в разделе `reports`, а не дублируется в `company`. `set_plan` и `rating_toggle` по кнопке пока отвечают подсказкой по использованию до S11. Тесты в `tests/botSections.test.js`. Следующий шаг S11.
- 2026-10-18, S11: `keyboards/managerPicker.ts` — `managerPickerKeyboard` (по 8, по две в ряд, навигация `‹ n/N ›` только при нескольких страницах, номер страницы ограничивается), `loadPickerManagers` (активные с `amoUserId`, по имени), `showManagerPicker` (редактирует сообщение при листании, иначе шлёт новое), `configureManagerPicker` для тестов. `actions/pickerFlows.ts` — упаковка нескольких аргументов в один callback через `_` (`splitPacked`/`packArgs`, все значения цифры или `YYYY-MM`), `parsePageToken` (`p<n>`), фабрики `createPickManagerCollect(actionId, {position, title})`, `createChoiceCollect(actionId, {position, title, options})`, `createSetPlanCollect(actionId)` (менеджер → ввод `plan_amount` → месяц: текущий/следующий по Алматы), обработчик ввода `plan_amount` через `parsePlanAmount`, `DAY_OPTIONS` (1/3/7/14), `planViewMonthOptions` (прошлый/текущий/следующий). В `ActionDefinition` добавлены `collect`, `decodeArg`, `confirmLabel`; `execute` для некомандных источников сначала спрашивает `collect`; `menuCallbacks` декодирует аргумент, подтверждает опасное действие только когда аргументы собраны (`needsMoreArgs`), текст подтверждения берёт из `confirmLabel`. Подключено: `set_plan` (цепочка), `rating_toggle` (варианты «Reytingdan chiqarish»/«Reytingga qaytarish» → выбор менеджера → подтверждение «reytingdan chiqarish, amoCRM ID …»), `call_status` (выбор дней), `plans` (выбор месяца). Команды с аргументами работают как раньше: `collect` не вызывается для источника `command`. Тесты `tests/botPickerFlows.test.js` (7), обновлён `botSections`. Следующий шаг S12.
- 2026-10-18, S12: раздел `phoenix` упорядочен через `order`: `inactivity_status` (Feniks holati), `inactivity_switch` (Feniks kaliti), `inactivity_limit` (Feniks limiti), `inactivity_on` (Feniksni yoqish), `inactivity_off` (Feniksni to'xtatish, `dangerous`, подтверждение `m:inactivity_off:yes`), `inactivity_lead` (вопрос `lead_id`, сделан в S8). Экран лимита при вызове с клавиатуры получает две inline-кнопки «Включить лимит» / «Снять лимит» (`m:inactivity_limit:on|off`), каждая перезапускает действие и показывает новое состояние с теми же кнопками; команда `/inactivity_limit*` остаётся текстовой. `inactivity_on` не помечен опасным: включение обратимо, а массовый перенос по-прежнему спрашивает «да/нет» через существующее `phx:`-подтверждение. Тексты раздела остались русскими. Тесты в `tests/botSections.test.js`. Следующий шаг S13.
- 2026-10-18, S13: `keyboards/managerPicker.ts` обобщён до любых элементов: `pickerKeyboard(items)`, источники `managers` (с фильтром по роли), `linkedUsers` (привязанные Telegram-аккаунты активных менеджеров, подпись «имя (роль)»), `teams`; `showPicker`, `pickerItemsFor`, `configureManagerPicker` с тремя подменяемыми загрузчиками; `managerPickerKeyboard`/`showManagerPicker` сохранены как обёртки. `pickerFlows.ts`: `createStepsCollect(actionId, steps)` — один аргумент на шаг (список или выбор), `ROLE_OPTIONS`. Подключено: `reset_code` (менеджер → подтверждение «amoCRM ID …»), `set_role` (привязанный пользователь → роль → подтверждение «Telegram ID … → роль»), `set_teamlead` (менеджер), `add_to_team` (менеджер → тимлид с фильтром `TEAMLEAD`), `remove_from_team` (менеджер), `delete_team` (команда → собственное подтверждение действия с деталями; флаг `dangerous` снят, чтобы не спрашивать дважды). Порядок раздела `users`: списки (10–13), люди (20–22), роли и команды (30–34), анализ сделки (40), отладочные `commandOnly` (90+); `sync`: 10–11. Карточка AI-задачи: «Указать срок» теперь ставит вопрос `task_due` (с кнопкой отмены) вместо подсказки с командой; обработчик проверяет формат и будущее время, затем идёт тем же путём, что `/call_task_time`; команда сохранена. Тесты `tests/botAdminFlows.test.js` (6), дополнен `botSections`. Этап 2 (разделы) закрыт. Следующий шаг S14.
- 2026-10-18, вне плана: по просьбе пользователя в главном меню админов первой строкой добавлена кнопка Mini App «Dashboard» (`web_app`, адрес из `ADMIN_DASHBOARD_URL`, по умолчанию `https://qadam-dogovor.uz/reports/tg/`, принимается только `https`). Кнопка открывает страницу внутри Telegram и текста не шлёт, маршрутизатор её не видит. Тесты в `botMainMenu`, переменная описана в `docs/admin-commands.md`.
- 2026-10-18, S14: `src/bot/stateStore.ts` — `KeyValueStore`, Redis-реализация с ленивым импортом, `createMemoryKeyValueStore` (TTL по часам) для тестов, `configureStateStore`, `createStateMap<T>(prefix, ttl)` с JSON и сбросом битых записей; `pendingInput` переиспользует Redis-хранилище. В `state.ts` четыре `Map` заменены на карты состояний: `aiSessions` (`bot:ai:`) и `supervisorAiSessions` (`bot:supai:`) с TTL 2 часа, обновляемым при каждом сообщении; `roleFlowState` (`bot:roleflow:`) и `teamLeadManageFlowState` (`bot:tlflow:`) с TTL 10 минут. Все места вызова переведены на `await`; после каждой мутации на месте (история диалога, страница и выбор в потоке тимлида) состояние пишется обратно явно. `showWhen` стал асинхронным, `sectionKeyboard` возвращает `Promise`. `awaitingCode` остался в памяти: при потере пользователь просто повторяет `/start`. Отличия от плана: история AI-сессии хранится целиком в Redis (до 40 сообщений, это десятки килобайт), а не указателем на БД; у потоков появился срок жизни, которого раньше не было. Тесты `tests/botStateStore.test.js` (4), остальные тесты разделов переведены на асинхронную клавиатуру. Следующий шаг S15.
- 2026-10-18, S15: три захардкоженных блока справки удалены; `helpTextFor(access, keyboards)` строит текст из реестра: заголовок по роли (админ / ROP / TeamLead / Mavjud buyruqlar), при включённых клавиатурах подсказка про меню, далее по видимым разделам строки `/команда - описание` (для действий с `menu` — каждая команда отдельной строкой; у первой строки подпись кнопки или список вариантов), в конце блок «Faqat buyruq bilan» с `commandOnly`-действиями. Новый флаг `helpHidden` скрывает служебные записи: `start`, `deal_usage`, `set_plan_usage`, `call_task_time`. Приветствие `/start` при включённых клавиатурах короткое и ведёт в меню и `/help`; при выключенных — прежний список. Отличия от прежнего поведения, принятые осознанно: ROP получает свой заголовок и свои разделы (раньше видел блок менеджера); деактивированный аккаунт получает текст для непривязанных (раньше справка активность не проверяла); группировка теперь по разделам меню, а не по прежним рукописным подзаголовкам. В `docs/admin-commands.md` добавлен раздел 2а «Кнопки и разделы» с таблицей из 52 строк, сгенерированной из собранного реестра. Тесты в `tests/botActions.test.js`. Следующий шаг S16.
- 2026-10-18, S16: `tests/botRights.test.js` — для каждого действия с ролями и каждого из шести профилей (непривязанный, деактивированный, менеджер, тимлид, РОП, админ), которому действие недоступно, `execute` шлёт ровно одно сообщение отказа и не вызывает `run` (подменяется `action.run`; проверено более ста пар), каждое ограниченное действие доступно хотя бы одному профилю, у каждого действия с обязательными аргументами есть `input` или `collect` (кнопка не упирается в подсказку), опасные действия имеют команду и подпись. `tests/botDispatch.test.js` — путь команды через `runCommand`: дедупликация (`claimUpdate` теперь в зависимостях диспетчера), захват аргументов с пропуском несовпавшей необязательной группы, отказ по роли; `handleLabelHit` для раздела, пустого раздела и «Yordam» (`resolveAccess` теперь в зависимостях маршрутизатора). Покрытие списка T16 закрыто. Следующий шаг S17.
- 2026-10-18, S17: `keyboardRolloutRoles`/`keyboardsEnabledFor(access)` в `mainMenu.ts` — `BOT_KEYBOARDS_ROLES` ограничивает клавиатуру перечисленными ролями (неизвестные имена игнорируются, пусто — все); `mainMenuMarkup`, `helpTextFor`, `startReply` и обновление меню после смены роли используют пользовательскую проверку, остальное читает флаг через ту же функцию. В `execute` одна строка лога на каждое выполненное или отклонённое действие: `[BotMenu] action=<id> source=<…> roles=<…> args=<n>`, без текста сообщений. В `docs/admin-commands.md` добавлены переменная и раздел «Порядок включения и откат». Тесты в `botMainMenu`, `botDispatch`, `botActions`. **Все 17 шагов реализованы.** Открыты только ручные контрольные точки пользователя: 1 (команды), 2 (меню и клавиатура), 3 (отчёты и AI), 4 (планы), 5 (админ), плюс проверки S9–S12 и S14. Дальнейшая работа — правки по итогам этих проверок.
- 2026-10-18, вне плана (уточнение): кнопка «Dashboard» по просьбе пользователя убрана из нижнего меню и поставлена первой inline-кнопкой раздела `reports` только для админов (`keyboards/dashboard.ts`, `dashboardInlineButton`; `sectionKeyboard` добавляет её строкой над действиями). Это `web_app`-кнопка без callback, в таблицу раздела 2а не входит. Тесты и документация обновлены.
- 2026-10-18, вне плана: калькулятор зарплаты. `services/salaryCalculator.ts` (чистые формулы платёжной таблицы «октябрь 2026», блок МОПЫ; тесты на пяти строках листа), `services/managerRate.ts` (ставка в `Manager.fixedMonthlyRate`, миграция `20261018120000_add_manager_fixed_monthly_rate`, чистая проверка `leadMaySetRate`), `actions/salary.ts`: действие `salary` (раздел `reports`, `order: 110`, видно и доступно только менеджерам с ролью MANAGER через `showWhen`/проверку в `run`; цепочка вопросов `salary_days` → `salary_plan` → `salary_fact`, ставка берётся из базы, иначе просьба обратиться к админу или тимлиду; результат HTML с пометкой про ручные бонусы и штрафы), `set_rate` (админ, раздел `users`, `order: 23`, выбор менеджера → ввод суммы) и `team_rate` (тимлид, раздел `team`, `order: 110`, выбор только из своей команды, проверка принадлежности при выполнении). Новый вид ввода `rate_amount`; `dispatchAnswer` принимает в payload `args` для аргументов, собранных до вопроса. Команд стало 62, `EXPECTED_COMMAND_COUNT` обновлён. Решения по ответам пользователя: период недельный и не фиксируется ботом, факт вводится вручную (по amoCRM), стажёры по тем же формулам, тимлиды и РОП вне калькулятора, смысл колонки M в таблице неизвестен и не используется. Документация: раздел 2б и обновлённая таблица 2а (55 строк).
