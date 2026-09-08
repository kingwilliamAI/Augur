# Фаза 3 — деплой. Пошагово

Всё, что ниже, выполняется по порядку. Каждый шаг заканчивается проверкой — если она не прошла, дальше идти нельзя, следующий шаг построится на сломанном.

**Домен нужен только на шаге 8.** Если он ещё не выбран, шаг 2 можно пропустить и вернуться к нему потом: шаги 1 и 3–7 поднимут полностью рабочий сервис, смотреть его до домена — через SSH-туннель, как описано в проверке шага 7.

Обозначения: `[локально]` — на девбоксе `185.194.140.152`, `[сервер]` — на новой машине.

---

## 0. Что понадобится заранее

- Аккаунт DigitalOcean
- Аккаунт Namecheap (домен покупаем на шаге 2)
- SSH-ключ. Проверить, что он есть:

```bash
ls -la ~/.ssh/id_ed25519.pub
```

Если нет — создать:

```bash
ssh-keygen -t ed25519 -C "augur"
```

---

## 1. Поднять машину — DigitalOcean

**Create → Droplets:**

| Параметр | Значение |
|---|---|
| Region | **Frankfurt** или Amsterdam |
| Image | Ubuntu 24.04 (LTS) x64 |
| Type | Basic → Regular (SSD) |
| Size | **$24/мес — 2 vCPU, 4 ГБ, 80 ГБ** |
| Authentication | **SSH Key** → добавить свой ключ прямо здесь |
| Hostname | augur |

**Почему именно эта конфигурация.** 4 ГБ нужны не доске, а ночному переобучению: оно держит в памяти матрицу на 170 тысяч строк. На тарифе с 2 ГБ доска и вотчер поживут, а `npm run nightly` в четыре утра упрётся в память и тихо умрёт — а это ровно тот отказ, который никто не заметит неделю. Диск 80 ГБ вместо нужных 40 берётся заодно, отдельно его не выбрать.

Регион — европейский, чтобы перелив базы с девбокса шёл быстро.

**Аутентификация: только SSH Key.** Если выбрать пароль, DigitalOcean пришлёт его почтой, и root с паролем будет торчать наружу до тех пор, пока не дойдёте до шага 3.

Про Cloud Firewall от DigitalOcean: можно не включать, на шаге 3 настраивается `ufw` на самой машине. Если включите оба — не забудьте, что запрещать будут оба, и отлаживать придётся в двух местах.

**Проверка:**

```bash
ssh root@СЕРВЕР_IP "echo ok && lsb_release -ds && nproc && free -g | head -2 && df -h / | tail -1"
```

Ожидаем `ok`, `Ubuntu 24.04`, `2`, около 4 ГБ памяти и ~80 ГБ диска.

---

## 2. Домен — Namecheap

*Этот шаг можно отложить. Он нужен только для шага 8; всё остальное поднимается без него.*

### Купить

На namecheap.com в поиске проверить свободные варианты. Ориентиры по цене за первый год:

| Зона | Цена | Замечание |
|---|---|---|
| `.xyz` | ~$2 | Дешевле всего, к почте и репутации домена придирчивее относятся спам-фильтры |
| `.com` | ~$10 | Скучно и надёжно |
| `.app` | ~$15 | В списке HSTS preload: браузеры **вообще** не откроют его по http. Нам подходит, TLS всё равно будет, но знать надо |
| `.dev` | ~$15 | То же самое |

При оформлении:

- **WhoisGuard / Domain Privacy — включить.** У Namecheap он бесплатный. Иначе телефон и почта уедут в публичный whois.
- **Auto-renew — включить.** Домен, отвалившийся по забывчивости, уводит сервис молча.
- От хостинга, почты и SSL, которые Namecheap предлагает в корзине, отказаться. SSL нам выпишет Caddy бесплатно.

### Настроить DNS

Namecheap → **Domain List** → напротив домена **Manage** → вкладка **Advanced DNS**.

Сначала **удалить** записи, которые Namecheap создаёт по умолчанию: там обычно висит `CNAME www → parkingpage.namecheap.com` и `URL Redirect Record`. Они перехватят домен и Caddy не получит сертификат.

Затем **Add New Record**:

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `@` | `СЕРВЕР_IP` | Automatic |
| A Record | `www` | `СЕРВЕР_IP` | Automatic |

Вторая запись нужна, только если хотите, чтобы `www.домен` тоже открывался. Тогда её надо будет упомянуть и в Caddyfile на шаге 8.

Убедиться, что вверху страницы в **Nameservers** стоит **Namecheap BasicDNS**. Если там чужие NS, записи на вкладке Advanced DNS просто не работают.

**Проверка.** Namecheap расходится дольше Cloudflare, обычно 5–30 минут:

```bash
dig +short ТВОЙ-ДОМЕН
dig +short ТВОЙ-ДОМЕН @8.8.8.8
```

Оба должны вернуть IP сервера. Пока не вернули — **дальше не идти**: шаг 8 упрётся ровно в это, а Let's Encrypt имеет лимит на неудачные попытки, и слишком ранний запуск Caddy может подвесить выдачу сертификата на час.

---

## 3. Пользователь и базовая защита

`[сервер]`, под root — это последний шаг, который выполняется от root напрямую. В конце его вход
root по SSH выключается, и дальше всё идёт под `augur` через `sudo`.

```bash
adduser --disabled-password --gecos "" augur
install -d -m 700 -o augur -g augur /home/augur/.ssh
cp /root/.ssh/authorized_keys /home/augur/.ssh/
chown augur:augur /home/augur/.ssh/authorized_keys
chmod 600 /home/augur/.ssh/authorized_keys
```

Запретить вход root по SSH и вход по паролю:

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

**Дать `augur` право на sudo — обязательно, и обязательно до того, как закроется эта root-сессия.**
Вход root по SSH только что выключен, а у нового пользователя пароля нет вообще. Если сейчас закрыть
окно, рута на машине больше не будет ни у кого:

```bash
usermod -aG sudo augur
echo "augur ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/augur
chmod 440 /etc/sudoers.d/augur
visudo -c
```

`NOPASSWD` тут не послабление: у пользователя нет пароля в принципе, вход только по ключу, поэтому
sudo с паролем не сработал бы никогда.

Файрвол — наружу только SSH и веб:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

**Проверка.** Не закрывая root-сессию, открыть новое окно терминала:

```bash
ssh augur@СЕРВЕР_IP "whoami && sudo -n whoami"
```

Должно вывести `augur` и `root`. Только после этого root-окно можно закрывать.

Если новая сессия не пускает или sudo просит пароль — **не закрывать старую**, чинить из неё.

### Чтобы не набирать адрес каждый раз

`[локально]`, в `~/.ssh/config`:

```
Host augur
    HostName СЕРВЕР_IP
    User augur
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

Дальше везде ниже вместо `augur@СЕРВЕР_IP` можно писать просто `augur`.

---

## 4. Node 22

Ubuntu 24.04 везёт Node 18, а проект требует 22.6+, потому что исполняет TypeScript напрямую без сборки.

`[сервер]`, под `augur`. Вход root по SSH отключён на шаге 3, поэтому всё, что требует прав,
делается через `sudo`:

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

`sudo -E` в третьей строке обязателен: скрипт NodeSource читает переменные окружения, и без `-E`
sudo их выбросит.

**Проверка:**

```bash
node --version
node -e "console.log(process.features.typescript)"
```

Ожидаем `v22.x` (не ниже 22.6) и `strip`. Если второе пусто — Node не умеет исполнять `.ts` и ничего не запустится.

---

## 5. Репозиторий

`[сервер]`, под пользователем `augur`:

```bash
git clone https://github.com/kingwilliamAI/Augur.git ~/augur
cd ~/augur
npm install
```

Конфиг:

```bash
cp .env.example .env
```

Открыть `.env` и выставить три строки — они и делают запуск безопасным:

```
BOARD_HOST=127.0.0.1
TRUST_PROXY=1
BOARD_PORT=4663
```

`BOARD_HOST=127.0.0.1` — доска слушает только локально, единственная дверь снаружи это Caddy.
`TRUST_PROXY=1` — иначе rate limit увидит все запросы как приходящие от Caddy, то есть с одного адреса, и посчитает весь интернет одним клиентом.

**Проверка:**

```bash
npm run doctor
```

Все строки должны быть `ok`. Если падает на эндпоинтах — дальше бессмысленно.

---

## 6. Данные

Два варианта. Первый быстрее, второй чище.

### Вариант А — перелить готовую базу (~187 МБ, пара минут)

SQLite пишет в WAL-файл рядом с базой. Копировать базу, пока в неё пишут, нельзя — приедет обрезанная. Поэтому сначала остановить писателей и слить WAL в основной файл.

`[локально]`:

```bash
pkill -f "src/cli/watch.ts"
pkill -f "src/cli/enrich"
sleep 2
node --no-warnings -e '
const { openDb } = await import("./src/db.ts");
const db = openDb();
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log("WAL слит в базу");
'
ls -la data/
```

`data/augur.db-wal` должен стать нулевого размера. Теперь копировать:

```bash
scp data/augur.db augur@СЕРВЕР_IP:~/augur/data/augur.db
```

### Вариант Б — собрать на месте (~13 минут)

```bash
npm run setup
```

Медленнее, но заодно проверяет ровно тот путь, который README обещает всем остальным. Замерено на девбоксе под нагрузкой: 12 минут 42 секунды, из них 5 минут бэкфилл и 7.6 минуты расшифровка. На пустой машине быстрее.

После этого стоит догнать остаток недели, уже не торопясь:

```bash
npm run enrich-window -- --hours 168
```

**Проверка** `[сервер]`:

```bash
npm run stats
```

Должны увидеть сотни тысяч запусков и градуации. Если база пустая — копия не доехала.

---

## 7. systemd

Три процесса. `[сервер]`, под `augur` через `sudo`.

Файлы юнитов создавать так, чтобы `sudo` относился к записи, а не только к `cat`:

```bash
sudo tee /etc/systemd/system/augur-board.service > /dev/null <<'EOF'
...содержимое ниже...
EOF
```

**Доска** — `/etc/systemd/system/augur-board.service`:

```ini
[Unit]
Description=Augur board
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=augur
WorkingDirectory=/home/augur/augur
ExecStart=/usr/bin/node --no-warnings src/board.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**Вотчер** — `/etc/systemd/system/augur-watch.service`:

```ini
[Unit]
Description=Augur live watcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=augur
WorkingDirectory=/home/augur/augur
ExecStart=/usr/bin/node --no-warnings src/cli/watch.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**Ночное переобучение** — `/etc/systemd/system/augur-nightly.service`:

```ini
[Unit]
Description=Augur nightly retrain

[Service]
Type=oneshot
User=augur
WorkingDirectory=/home/augur/augur
ExecStart=/usr/bin/npm run nightly
```

и таймер `/etc/systemd/system/augur-nightly.timer`:

```ini
[Unit]
Description=Augur nightly retrain

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

`Persistent=true` — если машина была выключена в 04:30, задание отработает после включения, а не пропустится молча.

Включить:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now augur-board augur-watch augur-nightly.timer
sudo systemctl status augur-board augur-watch --no-pager
```

**Проверка** `[сервер]`:

```bash
curl -s localhost:4663/api/health
```

Ждём `watcherSeenSecAgo` в пределах пары секунд и небольшое `behindSec`. Если `watcherSeenSecAgo` равно `null` — вотчер не стартовал, смотреть `journalctl -u augur-watch -n 50`.

---

### Перекалибровка на таймере

Модель со временем начинает завышать: она обучена на одной частоте успеха, а рынок живёт на другой.
Поправка подгоняется по собственному логу предсказаний и двигает только показываемый процент —
порядок в списке она изменить не может, поправка монотонная.

Почему таймером, а не в ночной работе: поправка привязана к отпечатку модели и для другой модели не
применяется. Ночное переобучение выдаёт новую модель, значит поправка, подогнанная перед ним, ей уже
не годится. Новая модель должна поработать без поправки, пока не отстоятся её собственные заявки, и
только потом получить свою.

```bash
sudo tee /etc/systemd/system/augur-recalibrate.service > /dev/null <<'EOF'
[Unit]
Description=Augur live recalibration

[Service]
Type=oneshot
User=augur
WorkingDirectory=/home/augur/augur
ExecStart=/usr/bin/npm run --silent recalibrate -- --write
EOF
sudo tee /etc/systemd/system/augur-recalibrate.timer > /dev/null <<'EOF'
[Unit]
Description=Augur live recalibration

[Timer]
OnBootSec=30min
OnUnitActiveSec=2h

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now augur-recalibrate.timer
```

Раз в два часа. Команда сама молчит и ничего не пишет, пока под текущей моделью не отстоятся 500
заявок, и отказывается применять поправку, которая слишком велика для двух параметров — это признак,
что смотреть надо на модель, а не подкручивать её вывод.

**Проверка:**

```bash
npm run recalibrate
```

Без `--write` она только считает и показывает, что сделала бы.

**Посмотреть глазами, ещё без домена.** Доска слушает только localhost, наружу порт закрыт, и так и должно остаться. Пробрасываем туннелем `[локально]`:

```bash
ssh -N -L 4664:localhost:4663 augur@СЕРВЕР_IP
```

и открываем `http://localhost:4664`. На этом месте сервис уже полностью рабочий: лента живая, вотчер пишет лог предсказаний. Шаги 2 и 8 добавляют к этому только домен и TLS.

---

## 8. Caddy и TLS

`[сервер]`, под `augur`:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile` — целиком заменить на:

```
ТВОЙ-ДОМЕН, www.ТВОЙ-ДОМЕН {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4663
}
```

Строку `www.` оставить, только если добавили вторую A-запись на шаге 2. Если её нет, Caddy будет пытаться выписать сертификат на несуществующее имя и не выпишет ни одного.

Редактировать конфиг: `sudo nano /etc/caddy/Caddyfile`

```bash
sudo systemctl reload caddy
sudo journalctl -u caddy -n 30 --no-pager
```

Сертификат Caddy получает сам за несколько секунд. В логе должно быть `certificate obtained successfully`.

**Проверка** `[локально]`:

```bash
curl -sI https://ТВОЙ-ДОМЕН | head -3
curl -s https://ТВОЙ-ДОМЕН/api/health
```

И отдельно — что прямой порт закрыт снаружи:

```bash
curl -s -m 5 http://СЕРВЕР_IP:4663/api/health && echo "ПЛОХО: порт открыт наружу" || echo "хорошо: порт закрыт"
```

---

## 9. Прогон

**Rate limit** `[локально]`:

```bash
for i in $(seq 1 70); do
  curl -s -o /dev/null -w "%{http_code}\n" https://ТВОЙ-ДОМЕН/api/health
done | sort | uniq -c
```

Ожидаем примерно 60 ответов `200` и остальные `429`. Если все 70 прошли — не подхватился `TRUST_PROXY=1`, проверить `.env` и перезапустить доску.

**Переживает ли ребут:**

```bash
ssh augur "sudo reboot"
sleep 45
curl -s https://ТВОЙ-ДОМЕН/api/health
```

Должно ответить без ручного вмешательства. Это главная проверка всего шага 7.

**Лог предсказаний наполняется** `[сервер]`, через несколько минут после старта:

```bash
cd ~/augur && npm run scoreboard
```

Первые оценённые claims появятся через 4 часа — столько настаивается горизонт. До этого команда честно скажет, сколько заявок ждёт своей очереди.

**Финальный чеклист:**

- [ ] `https://ТВОЙ-ДОМЕН` открывается, сертификат валидный
- [ ] Лента заполнена, возраст верхних запусков — секунды или минуты
- [ ] Плашки про отставание нет (или жёлтая, если догоняет)
- [ ] Переключатель `by chance` / `newest` работает
- [ ] Карточка открывается мгновенно, адрес контракта копируется
- [ ] Порт 4663 снаружи закрыт
- [ ] После ребута всё поднялось само

---

## Если что-то сломалось

```bash
journalctl -u augur-board -n 100 --no-pager     # доска
journalctl -u augur-watch -f                    # вотчер, живой лог
journalctl -u caddy -n 50 --no-pager              # сертификаты и проксирование
systemctl list-timers augur-nightly.timer       # когда следующее переобучение
```

**Доска отвечает, но лента пустая.** Нет модели или нет данных за последние 6 часов. Проверить `ls -la data/model.json` и `npm run stats`.

**Красная плашка «watcher has not reported».** Вотчер упал или не может достучаться до RPC. `journalctl -u augur-watch -n 50`.

**Caddy не берёт сертификат.** Почти всегда DNS. Проверить по порядку:

```bash
dig +short ТВОЙ-ДОМЕН @8.8.8.8      # видит ли внешний резолвер IP сервера
journalctl -u caddy -n 50 --no-pager
```

Частые причины именно с Namecheap: не удалён `URL Redirect Record` или `CNAME www → parkingpage`; в Nameservers стоит не BasicDNS; запись ещё не разошлась. Если Let's Encrypt уже отбил несколько попыток, подождать час — у него лимит на неудачи.

**Всё встало через несколько дней.** Скорее всего публичный RPC. Это известный и принятый риск: `eth_getLogs` на этой цепи отдаёт ровно один публичный эндпоинт, запасного нет. `npm run doctor` покажет.

---

## Что осталось за рамками этого шага

Сознательно отложено, чтобы не делать в ночь деплоя:

- **Чистка старых данных.** База растёт на ~26 МБ в сутки, 40 ГБ хватит года на три. Но политику надо завести.
- **Запасной RPC.** Надо выяснить, существуют ли платные провайдеры для Robinhood Chain. Пока продукт висит на чужом бесплатном эндпоинте.
- **Скорборд отдельной страницей.** Сейчас только CLI. Смысл появится, когда в логе накопятся оценённые предсказания — то есть через сутки-другие после запуска.
- **Мониторинг.** Ничего не разбудит ночью, если сервис встанет. Минимум — внешняя проверка `/api/health` раз в пять минут.
