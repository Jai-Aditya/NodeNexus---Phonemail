<#
  PhoneMail end-to-end smoke test.

  Drives the running system (docker compose up -d) the way real users would and checks
  every answer. Each run uses brand-new phone numbers, so you can run it again and again.

  Needs .env (next to docker-compose.yml) to contain:
      AUTH_MODE=console
      TWILIO_AUTH_TOKEN=local-test-token
      PUBLIC_BASE_URL=http://localhost:3000

  Run from the phonemail folder:
      powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1

  Works in Windows PowerShell 5.1 and PowerShell 7.
#>
param(
  [string]$Base = 'http://localhost:3000',
  [string]$MailBase = 'http://localhost:8081',
  [string]$LogFile = ''   # read OTP codes from this file instead of `docker compose logs api`
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$script:passed = 0
$script:failed = 0

function Check([string]$name, [bool]$ok, $detail = '') {
  if ($ok) {
    $script:passed++
    Write-Host "  PASS  $name" -ForegroundColor Green
  } else {
    $script:failed++
    Write-Host "  FAIL  $name" -ForegroundColor Red
    if ($detail) { Write-Host "        $detail" -ForegroundColor DarkGray }
  }
}

function Section([string]$title) { Write-Host ''; Write-Host "== $title" -ForegroundColor Cyan }

# ---------- HTTP helpers (HttpClient: never throws on 4xx/5xx, keeps cookies per client) ----------

function New-Client {
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.CookieContainer = New-Object System.Net.CookieContainer
  $handler.UseCookies = $true
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(30)
  return $client
}

function Invoke-Api($client, [string]$method, [string]$url, $body = $null, [hashtable]$headers = @{}, [switch]$NoCsrf) {
  if ($url.StartsWith('/')) { $url = $Base + $url }
  $req = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($method)), $url)
  if (-not $NoCsrf) { [void]$req.Headers.TryAddWithoutValidation('X-Requested-With', 'smoke-test') }
  foreach ($k in $headers.Keys) { [void]$req.Headers.TryAddWithoutValidation($k, [string]$headers[$k]) }
  if ($null -ne $body) {
    if ($body -is [System.Net.Http.HttpContent]) {
      $req.Content = $body
    } else {
      $json = ConvertTo-Json $body -Depth 10 -Compress
      $req.Content = New-Object System.Net.Http.StringContent($json, [Text.Encoding]::UTF8, 'application/json')
    }
  }
  $res = $client.SendAsync($req).GetAwaiter().GetResult()
  $text = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  $parsed = $null
  try { $parsed = $text | ConvertFrom-Json } catch { }
  $code = $null
  if ($parsed -and $parsed.error) { $code = $parsed.error.code }
  return [pscustomobject]@{ Status = [int]$res.StatusCode; Text = $text; Json = $parsed; Code = $code; Response = $res }
}

function Get-Log {
  if ($LogFile) { return (Get-Content -Raw $LogFile) }
  $ErrorActionPreference = 'Continue'   # docker may print warnings on stderr; don't treat them as errors
  return ((docker compose logs api --since 15m 2>$null) -join "`n")
}

# The API prints "[dev OTP] code for +91...: 123456" in console mode.
function Get-OtpCode([string]$e164) {
  $pattern = 'code for ' + [regex]::Escape($e164) + ': (\d{6})'
  for ($i = 0; $i -lt 20; $i++) {
    $all = [regex]::Matches((Get-Log), $pattern)
    if ($all.Count -gt 0) { return $all[$all.Count - 1].Groups[1].Value }
    Start-Sleep -Milliseconds 250
  }
  throw "No OTP code for $e164 in the API log. Is AUTH_MODE=console?"
}

function Login([string]$phone, [string]$name) {
  $c = New-Client
  $start = Invoke-Api $c POST '/api/auth/otp/start' @{ phone = $phone }
  if ($start.Status -eq 429) { throw "Rate limited ($($start.Text)). Run: docker compose restart api   (limits are kept in memory)" }
  if ($start.Status -ne 200) { throw "OTP start for $phone failed: $($start.Status) $($start.Text)" }
  $code = Get-OtpCode $start.Json.phone
  $v = Invoke-Api $c POST '/api/auth/otp/verify' @{ phone = $phone; code = $code; client = 'web' }
  if ($v.Status -ne 200 -and $v.Status -ne 201) { throw "OTP verify for $phone failed: $($v.Status) $($v.Text)" }
  [void](Invoke-Api $c PATCH '/api/me' @{ display_name = $name })
  return [pscustomobject]@{ Client = $c; User = $v.Json.user; Phone = $start.Json.phone; Name = $name }
}

function Read-Env {
  $vals = @{}
  if (Test-Path "$root\.env") {
    foreach ($line in Get-Content "$root\.env") {
      if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)\s*$') { $vals[$matches[1]] = $matches[2].Trim('"') }
    }
  }
  return $vals
}

# Twilio's signature: base64(HMAC-SHA1(auth token, url + each param name+value sorted by name)).
function Invoke-Twilio([string]$path, [hashtable]$form, [string]$token, [string]$publicBase, [string]$forceSignature = '') {
  $keys = [string[]]@($form.Keys)
  [Array]::Sort($keys, [StringComparer]::Ordinal)
  $data = $publicBase + $path
  foreach ($k in $keys) { $data += $k + $form[$k] }
  $hmac = New-Object System.Security.Cryptography.HMACSHA1(,[Text.Encoding]::UTF8.GetBytes($token))
  $sig = [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($data)))
  if ($forceSignature) { $sig = $forceSignature }
  $dict = New-Object 'System.Collections.Generic.Dictionary[string,string]'
  foreach ($k in $form.Keys) { $dict.Add($k, [string]$form[$k]) }
  $content = New-Object System.Net.Http.FormUrlEncodedContent($dict)
  return Invoke-Api (New-Client) POST $path $content @{ 'X-Twilio-Signature' = $sig } -NoCsrf
}

# ---------- Server-Sent Events: open the stream, then wait for a named event ----------

function Open-Events($client) {
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "$Base/api/events")
  $res = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  $stream = $res.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
  return [pscustomobject]@{ Response = $res; Reader = (New-Object System.IO.StreamReader($stream)); Pending = $null }
}

function Wait-Event($events, [string]$type, [int]$seconds = 8) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $current = $null
  while ((Get-Date) -lt $deadline) {
    if ($null -eq $events.Pending) { $events.Pending = $events.Reader.ReadLineAsync() }
    $left = [int][Math]::Max(1, ($deadline - (Get-Date)).TotalMilliseconds)
    if (-not $events.Pending.Wait($left)) { return $null }
    $line = $events.Pending.Result
    $events.Pending = $null
    if ($null -eq $line) { return $null }
    if ($line.StartsWith('event: ')) { $current = $line.Substring(7) }
    elseif ($line.StartsWith('data: ') -and $current -eq $type) { return ($line.Substring(6) | ConvertFrom-Json) }
  }
  return $null
}

# =====================================================================================
$envVals = Read-Env
$run = Get-Random -Minimum 10000 -Maximum 99999
function Phone([int]$n) { return ('7{0}{1:D4}' -f $run, $n) }   # 10 digits, new every run
Write-Host "PhoneMail smoke test (run $run) against $Base"

Section 'Health and configuration'
$anon = New-Client
$h = Invoke-Api $anon GET '/api/health'
Check 'API is healthy' ($h.Status -eq 200) $h.Text
Check 'API can reach the database' ($h.Json.database -eq $true) $h.Text
Check 'API can reach the mail service' ($h.Json.mail_service -eq $true) $h.Text
Check 'AUTH_MODE is console (needed for this test)' ($h.Json.auth_mode -eq 'console') "auth_mode = $($h.Json.auth_mode). Put AUTH_MODE=console in .env and run: docker compose up -d"
if ($h.Status -ne 200 -or $h.Json.auth_mode -ne 'console') { Write-Host 'Stopping: fix the above first.' -ForegroundColor Yellow; exit 1 }

Section 'Security'
$r = Invoke-Api $anon GET '/api/me'
Check 'Not logged in: /api/me is 401' ($r.Status -eq 401) $r.Text
$r = Invoke-Api $anon GET '/api/mail/conversations'
Check 'Not logged in: mail is 401' ($r.Status -eq 401) $r.Text
$r = Invoke-Api $anon POST '/api/auth/otp/start' @{ phone = (Phone 99) } -NoCsrf
Check 'POST without X-Requested-With is blocked (CSRF)' ($r.Status -eq 403 -and $r.Code -eq 'csrf') $r.Text
$r = Invoke-Api $anon GET "$MailBase/conversations" $null @{ 'X-User-ID' = '1' } -NoCsrf
Check 'Mail service refuses calls without the internal token' ($r.Status -eq 401) $r.Text
$r = Invoke-Api $anon POST '/api/auth/otp/start' @{ phone = '12345' }
Check 'Invalid phone number is rejected' ($r.Status -eq 400) $r.Text

Section 'OTP login'
$c = New-Client
$pa = Phone 1
$r = Invoke-Api $c POST '/api/auth/otp/start' @{ phone = $pa }
Check 'Code requested' ($r.Status -eq 200) $r.Text
Check 'Number normalised to +91' ($r.Json.phone -eq "+91$pa") $r.Text
Check 'The code is NOT in the response (only sent + phone)' ((@($r.Json.PSObject.Properties.Name) -join ',') -eq 'sent,phone') $r.Text
$r2 = Invoke-Api $c POST '/api/auth/otp/start' @{ phone = $pa }
Check 'Second request within 30s is rate limited (429)' ($r2.Status -eq 429) $r2.Text
$code = Get-OtpCode "+91$pa"
$wrong = '000000'; if ($code -eq '000000') { $wrong = '111111' }
$r = Invoke-Api $c POST '/api/auth/otp/verify' @{ phone = $pa; code = $wrong }
Check 'Wrong code is rejected (401)' ($r.Status -eq 401 -and $r.Code -eq 'wrong_code') $r.Text
$r = Invoke-Api $c POST '/api/auth/otp/verify' @{ phone = $pa; code = $code; client = 'web' }
Check 'Right code creates the account (201)' ($r.Status -eq 201 -and $r.Json.created -eq $true) $r.Text
Check "Address is $pa@..." ($r.Json.user.address -like "$pa@*") $r.Text
$setCookie = $null
$cookie = ''
if ($r.Response.Headers.TryGetValues('Set-Cookie', [ref]$setCookie)) { $cookie = ($setCookie -join ';') }
Check 'Session cookie is HttpOnly' ($cookie -match 'pm_session=' -and $cookie -match 'HttpOnly') $cookie
$r = Invoke-Api $c GET '/api/me'
Check 'Logged in: /api/me works' ($r.Status -eq 200 -and $r.Json.phone -eq "+91$pa") $r.Text
$r = Invoke-Api (New-Client) POST '/api/auth/otp/verify' @{ phone = $pa; code = $code }
Check 'A code only works once' ($r.Status -eq 401) $r.Text

$A = [pscustomobject]@{ Client = $c; User = (Invoke-Api $c GET '/api/me').Json; Phone = "+91$pa"; Name = 'Smoke A' }
[void](Invoke-Api $c PATCH '/api/me' @{ display_name = 'Smoke A' })
$B = Login (Phone 2) 'Smoke B'
$C = Login (Phone 3) 'Smoke C'
Check 'Three test users logged in' ($A.User.id -and $B.User.id -and $C.User.id)

Section 'Profile and aliases'
$r = Invoke-Api $A.Client PATCH '/api/me' @{ display_name = '  Smoke A  '; language = 'ta' }
Check 'Name trimmed and language saved' ($r.Json.display_name -eq 'Smoke A' -and $r.Json.language -eq 'ta') $r.Text
$alias = "smoke$run"
$r = Invoke-Api $A.Client POST '/api/me/aliases' @{ alias = $alias }
Check 'Alias added' ($r.Status -eq 201) $r.Text
$r = Invoke-Api $B.Client POST '/api/me/aliases' @{ alias = $alias }
Check 'Same alias for someone else is refused (409)' ($r.Status -eq 409 -and $r.Code -eq 'alias_taken') $r.Text
$r = Invoke-Api $B.Client POST '/api/me/aliases' @{ alias = '9876543210' }
Check 'All-digit alias is refused' ($r.Status -eq 400) $r.Text

Section 'Sending mail, live events and SMS alerts'
$events = Open-Events $B.Client
Check 'B opened the live event stream' ([int]$events.Response.StatusCode -eq 200)
$ready = Wait-Event $events 'ready' 5
Check "Stream says ready for B" ($ready -and $ready.user_id -eq $B.User.id) ($ready | ConvertTo-Json -Compress)
$subject = "Smoke $run"
$r = Invoke-Api $A.Client POST '/api/mail/messages' @{ to = @{ address = $B.User.address }; subject = $subject; body_text = 'Hello B' }
Check 'A sends to B (201)' ($r.Status -eq 201) $r.Text
$msgId = $r.Json.message_id
$ev = Wait-Event $events 'message' 8
Check 'B gets the message live (SSE)' ($ev -and $ev.message_id -eq $msgId -and $ev.subject -eq $subject) ($ev | ConvertTo-Json -Compress)
$events.Response.Dispose()

$expected = "You have received an email from Smoke A ($($A.User.address)). Subject: $subject."
$found = $false
for ($i = 0; $i -lt 20 -and -not $found; $i++) { $found = (Get-Log).Contains($expected); if (-not $found) { Start-Sleep -Milliseconds 250 } }
Check 'SMS alert for B has the exact wording from the brief' $found "Looked for: $expected"

$r = Invoke-Api $B.Client GET '/api/mail/conversations?filter=unread'
$chat = $r.Json.items | Where-Object { $_.last_message_id -eq $msgId } | Select-Object -First 1
Check "B's Home shows the chat as unread" ($chat -and $chat.unread_count -ge 1) $r.Text
$r = Invoke-Api $B.Client POST "/api/mail/messages/$msgId/reply" @{ conversation_id = $chat.conversation_id; body_text = 'Hi A' }
Check 'B replies (201)' ($r.Status -eq 201) $r.Text
$r = Invoke-Api $B.Client POST "/api/mail/messages/$msgId/reply" @{ conversation_id = $chat.conversation_id; body_text = 'Again' }
Check 'B cannot reply to the same message twice (409)' ($r.Status -eq 409 -and $r.Code -eq 'already_replied') $r.Text
$r = Invoke-Api $C.Client POST '/api/mail/messages' @{ to = @{ address = "$alias@$(($A.User.address -split '@')[1])" }; subject = 'To your alias'; body_text = 'hi' }
Check 'C mails A by alias (201)' ($r.Status -eq 201) $r.Text
$r = Invoke-Api $A.Client GET '/api/mail/conversations'
$aliasChat = $r.Json.items | Where-Object { $_.peer.user_id -eq $C.User.id }
Check 'A received the alias mail' ($null -ne $aliasChat) $r.Text
$r = Invoke-Api $C.Client GET "/api/mail/conversations/$($chat.conversation_id)/messages"
Check "C cannot read A and B's chat" ($r.Status -eq 403 -or $r.Status -eq 404) "$($r.Status) $($r.Text)"

$longText = ('This is a long email. ' * 20).Trim()
$r = Invoke-Api $A.Client POST '/api/mail/messages' @{ to = @{ address = $B.User.address }; subject = 'Long one'; body_text = $longText }
$longId = $r.Json.message_id
$r = Invoke-Api $B.Client GET "/api/mail/conversations/$($chat.conversation_id)/messages"
$listed = $r.Json.items | Where-Object { $_.id -eq $longId }
Check 'A long email is listed as a preview of at most 100 characters' ($listed -and $listed.truncated -and $listed.body_text.Length -le 101) $r.Text
$r = Invoke-Api $B.Client GET "/api/mail/messages/$($longId)?conversation_id=$($chat.conversation_id)"
Check 'Opening it shows the whole email' ($r.Status -eq 200 -and $r.Json.body_text -eq $longText -and -not $r.Json.truncated) $r.Text

Section 'Archive, snooze, reactions, send later, blocking and search operators'
$conv = $chat.conversation_id
$r = Invoke-Api $B.Client POST '/api/mail/conversations/actions' @{ conversation_ids = @($conv); action = 'archive' }
Check 'B archives the chat with A' ($r.Status -eq 200 -and $r.Json.changed -eq 1) $r.Text
$r = Invoke-Api $B.Client GET '/api/mail/conversations'
Check 'It leaves B''s Inbox' (-not ($r.Json.items | Where-Object { $_.conversation_id -eq $conv })) $r.Text
$r = Invoke-Api $B.Client GET '/api/mail/conversations?filter=everything'
Check 'All mail still lists it, marked archived' (@($r.Json.items | Where-Object { $_.conversation_id -eq $conv -and $_.archived }).Count -eq 1) $r.Text
$until = (Get-Date).ToUniversalTime().AddHours(2).ToString('o')
$r = Invoke-Api $B.Client POST '/api/mail/conversations/actions' @{ conversation_ids = @($conv); action = 'snooze'; until = $until }
$r2 = Invoke-Api $B.Client GET "/api/mail/conversations/$conv"
Check 'B snoozes it for two hours' ($r.Status -eq 200 -and $r2.Json.snoozed_until) $r2.Text
Invoke-Api $B.Client POST '/api/mail/conversations/actions' @{ conversation_ids = @($conv); action = 'unsnooze' } | Out-Null

$r = Invoke-Api $B.Client PUT "/api/mail/messages/$msgId/reaction" @{ emoji = [char]::ConvertFromUtf32(0x1F44D) }
$r2 = Invoke-Api $A.Client GET "/api/mail/messages/$msgId"
Check 'B reacts with a thumbs-up; A sees it' ($r.Status -eq 200 -and $r2.Json.reactions[0].count -eq 1) $r2.Text
$r = Invoke-Api $B.Client PUT "/api/mail/messages/$msgId/reaction" @{ emoji = 'hello' }
Check 'Only the offered emoji are accepted' ($r.Status -eq 400) $r.Text

$r = Invoke-Api $A.Client POST '/api/mail/drafts' @{ recipients = @{ to = @{ address = $B.User.address } }; subject = 'Later'; body_text = 'Scheduled' }
$did = $r.Json.id
$at = (Get-Date).ToUniversalTime().AddDays(1).ToString('o')
$r = Invoke-Api $A.Client POST "/api/mail/drafts/$did/send" @{ send_at = $at }
Check 'A schedules an email for tomorrow (202)' ($r.Status -eq 202 -and $r.Json.send_at) $r.Text
$r = Invoke-Api $A.Client POST "/api/mail/drafts/$did/unschedule" @{}
Check 'And takes it back: an ordinary draft again' ($r.Status -eq 200 -and -not $r.Json.send_at) $r.Text
$r = Invoke-Api $A.Client POST "/api/mail/drafts/$did/send" @{ delay_seconds = 2 }
Check 'Undo send: sent after a 2-second wait' ($r.Status -eq 202) $r.Text
$gone = $false
for ($i = 0; $i -lt 30 -and -not $gone; $i++) { Start-Sleep -Milliseconds 300; $gone = (Invoke-Api $A.Client GET "/api/mail/drafts/$did").Status -eq 404 }
$r = Invoke-Api $B.Client GET "/api/mail/search?q=$([uri]::EscapeDataString('scheduled from:' + $A.User.address))"
Check 'The scheduler sent it; B finds it with from:' ($gone -and @($r.Json.messages | Where-Object { $_.subject -eq 'Later' }).Count -eq 1) $r.Text

$r = Invoke-Api $B.Client POST '/api/mail/blocks' @{ address = $C.User.address }
Check 'B blocks C' ($r.Status -eq 201 -and $r.Json.user_id -eq $C.User.id) $r.Text
Invoke-Api $C.Client POST '/api/mail/messages' @{ to = @{ address = $B.User.address }; subject = "Blocked $run"; body_text = 'let me in' } | Out-Null
$r = Invoke-Api $B.Client GET '/api/mail/folders/spam'
Check 'C''s next email lands in B''s Spam' (@($r.Json.items | Where-Object { $_.subject -eq "Blocked $run" }).Count -eq 1) $r.Text
$r = Invoke-Api $B.Client DELETE "/api/mail/blocks/$($C.User.id)"
Check 'B unblocks C' ($r.Status -eq 200) $r.Text

Section 'Mail from outside (SMTP, as Postfix hands it over)'
function Send-Smtp([string[]]$rcpts, [string]$data, [int]$port = $(if ($env:SMTP_PORT) { [int]$env:SMTP_PORT } else { 2525 })) {
  $tcp = New-Object System.Net.Sockets.TcpClient('127.0.0.1', $port)
  $stream = $tcp.GetStream()
  $reader = New-Object System.IO.StreamReader($stream)
  $writer = New-Object System.IO.StreamWriter($stream)
  $writer.NewLine = "`r`n"; $writer.AutoFlush = $true
  $answers = @()
  $read = { do { $l = $reader.ReadLine() } while ($l -match '^\d{3}-'); $l }
  $answers += & $read
  $writer.WriteLine('EHLO postfix'); $answers += & $read
  $writer.WriteLine('MAIL FROM:<friend@gmail.com>'); $answers += & $read
  foreach ($r in $rcpts) { $writer.WriteLine("RCPT TO:<$r>"); $answers += & $read }
  $writer.WriteLine('DATA'); $answers += & $read
  $writer.WriteLine("$data`r`n."); $answers += & $read
  $writer.WriteLine('QUIT'); $answers += & $read
  $tcp.Close()
  return $answers
}
$outsideSubject = "From Gmail $run"
$data = "From: Friend <friend@gmail.com>`r`nTo: $($B.User.address)`r`nSubject: $outsideSubject`r`nMessage-ID: <smoke-$run@gmail.com>`r`n`r`nHello from outside"
$answers = Send-Smtp @("0000000000@$(($B.User.address -split '@')[1])", $B.User.address) $data
Check 'An unknown address is refused at RCPT (550)' ($answers[3] -like '550*') ($answers -join ' | ')
Check 'The email is accepted for B (250 Delivered)' ($answers[6] -like '250*Delivered*') ($answers -join ' | ')
$r = Invoke-Api $B.Client GET '/api/mail/conversations'
$outChat = $r.Json.items | Where-Object { $_.peer.address -eq 'friend@gmail.com' } | Select-Object -First 1
Check 'B has a chat with the outsider, unread' ($outChat -and $outChat.unread_count -eq 1 -and $outChat.peer.display_name -eq 'Friend') $r.Text
$expected = "You have received an email from Friend (friend@gmail.com). Subject: $outsideSubject."
$found = $false
for ($i = 0; $i -lt 20 -and -not $found; $i++) { $found = (Get-Log).Contains($expected); if (-not $found) { Start-Sleep -Milliseconds 250 } }
Check 'B gets the SMS alert naming the outside sender' $found "Looked for: $expected"
$envVals = Read-Env
if ($envVals['SMTP_RELAY'] -and $envVals['COMPOSE_PROFILES'] -match 'postfix') {
  Section 'Postfix in Docker ("SMTP local"): in on port 25, out to the internet'
  $pfPort = [int]$(if ($envVals['POSTFIX_PORT']) { $envVals['POSTFIX_PORT'] } else { 25 })
  $pfSubject = "Through Postfix $run"
  $data = "From: Friend <friend@gmail.com>`r`nTo: $($B.User.address)`r`nSubject: $pfSubject`r`n`r`nVia the Postfix container"
  $answers = Send-Smtp @("0000000000@$(($B.User.address -split '@')[1])", $B.User.address) $data $pfPort
  Check 'Postfix refuses an unknown number after asking PhoneMail (550)' ($answers[3] -like '550*') ($answers -join ' | ')
  Check 'Postfix accepts mail for B' ($answers[6] -like '250*') ($answers -join ' | ')
  $got = $null
  for ($i = 0; $i -lt 30 -and -not $got; $i++) {
    Start-Sleep -Milliseconds 500
    $got = (Invoke-Api $B.Client GET "/api/mail/search?q=$([uri]::EscapeDataString('from:friend@gmail.com in:anywhere'))").Json.messages | Where-Object { $_.subject -eq $pfSubject }
  }
  Check 'Postfix hands it to PhoneMail: B has it' ($null -ne $got) ''
  $r = Invoke-Api $B.Client POST '/api/mail/messages' @{ to = @{ address = 'friend@gmail.com' }; subject = "Back $run"; body_text = 'hi' }
  Check 'B writes back to the Gmail address (201)' ($r.Status -eq 201) $r.Text
  $handed = $false
  for ($i = 0; $i -lt 30 -and -not $handed; $i++) {
    Start-Sleep -Milliseconds 500
    $handed = [bool]((docker compose -f "$root\docker-compose.yml" logs postfix --since 2m 2>&1 | Out-String) -match "from=<$([regex]::Escape($B.User.address))>")
  }
  Check 'The mail service hands it to Postfix for delivery' $handed ''
} else {
  $r = Invoke-Api $B.Client POST '/api/mail/messages' @{ to = @{ address = 'friend@gmail.com' }; subject = 'Back'; body_text = 'hi' }
  Check 'Replying outside is refused while no relay is set (400 external_disabled)' ($r.Status -eq 400 -and $r.Code -eq 'external_disabled') $r.Text
}

Section 'Groups'
$r = Invoke-Api $A.Client POST '/api/mail/groups' @{ name = "Team $run"; members = @(@{ address = $B.User.address }, @{ address = $C.User.address }) }
Check 'A creates a group with B and C' ($r.Status -eq 201 -or $r.Status -eq 200) $r.Text
$gid = $r.Json.conversation_id
$admin = $r.Json.members | Where-Object { $_.user_id -eq $A.User.id }
Check 'A is the admin' ($admin -and $admin.role -eq 'admin') $r.Text
$r = Invoke-Api $A.Client POST '/api/mail/messages' @{ to = @{ group_id = $gid }; subject = 'Standup'; body_text = 'Hello team' }
Check 'A sends to the group' ($r.Status -eq 201) $r.Text
$r = Invoke-Api $C.Client GET "/api/mail/conversations/$gid/messages"
Check 'C sees the group message' ($r.Status -eq 200 -and ($r.Text -match 'Hello team')) $r.Text
$r = Invoke-Api $A.Client POST '/api/mail/messages' @{ to = @(@{ address = $C.User.address }, @{ address = $B.User.address }); subject = 'No name'; body_text = 'hi both' }
Check 'Two people in To without a group name: asked for one' ($r.Status -eq 400 -and $r.Json.error.code -eq 'group_name_required') "$($r.Status) $($r.Text)"
$r = Invoke-Api $A.Client POST '/api/mail/messages' @{ to = @{ group = "team $run" }; subject = 'By name'; body_text = 'hi team' }
Check 'An existing group is reached by its name' ($r.Status -eq 201 -and $r.Json.conversation_ids[0] -eq $gid) $r.Text
$r = Invoke-Api $C.Client POST "/api/mail/groups/$gid/leave" @{}
Check 'C leaves the group' ($r.Status -eq 200 -or $r.Status -eq 204) $r.Text
$r = Invoke-Api $C.Client POST '/api/mail/messages' @{ to = @{ group_id = $gid }; subject = 'x'; body_text = 'still here?' }
Check 'C can no longer send to the group' ($r.Status -ge 400 -and $r.Status -lt 500) "$($r.Status) $($r.Text)"
$r = Invoke-Api $C.Client GET "/api/mail/conversations/$gid/messages"
Check 'C sees the activity line for leaving' ($r.Status -eq 200 -and ($r.Json.events | Where-Object { $_.text -eq 'You left' })) $r.Text
$r = Invoke-Api $A.Client POST '/api/mail/messages' @{ to = @(@{ address = $B.User.address }, @{ address = $C.User.address }); group_name = "Trip $run"; subject = 'New group'; body_text = 'hello again' }
$newGid = if ($r.Json.conversation_ids) { $r.Json.conversation_ids[0] } else { $null }
Check 'Two people in To with a name start a new group from Home' ($r.Status -eq 201 -and $newGid -and $newGid -ne $gid) $r.Text
$r = Invoke-Api $C.Client GET "/api/mail/groups/$newGid"
Check 'C is in it, with the given name' ($r.Status -eq 200 -and $r.Json.members.Count -eq 3 -and $r.Json.name -eq "Trip $run") $r.Text

Section 'Attachments (1 MB round trip)'
$r = Invoke-Api $A.Client POST '/api/mail/drafts' @{ recipients = @{ to = @{ address = $B.User.address } }; subject = 'File'; body_text = 'see attached' }
Check 'Draft saved' ($r.Status -eq 201) $r.Text
$draftId = $r.Json.id
$bytes = New-Object byte[] (1024 * 1024)
(New-Object System.Random).NextBytes($bytes)
$form = New-Object System.Net.Http.MultipartFormDataContent
$file = New-Object System.Net.Http.ByteArrayContent(,$bytes)
$file.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/octet-stream')
$form.Add($file, 'file', 'smoke.bin')
$r = Invoke-Api $A.Client POST "/api/mail/drafts/$draftId/attachments" $form
Check 'Upload through the API (201)' ($r.Status -eq 201 -and $r.Json.size_bytes -eq $bytes.Length) $r.Text
$attId = $r.Json.id
$r = Invoke-Api $A.Client POST "/api/mail/drafts/$draftId/send" @{}
Check 'Draft sent' ($r.Status -eq 201 -or $r.Status -eq 200) $r.Text
$dl = $B.Client.GetByteArrayAsync("$Base/api/mail/attachments/$attId").GetAwaiter().GetResult()
$sha = [System.Security.Cryptography.SHA256]::Create()
$same = ([Convert]::ToBase64String($sha.ComputeHash($bytes)) -eq [Convert]::ToBase64String($sha.ComputeHash($dl)))
Check 'B downloads exactly the same bytes (SHA-256 match)' $same "uploaded $($bytes.Length), downloaded $($dl.Length)"
$r = Invoke-Api $C.Client GET "/api/mail/attachments/$attId"
Check "C cannot download B's attachment" ($r.Status -eq 403 -or $r.Status -eq 404) "$($r.Status)"

Section 'Sign-up by SMS and phone call (Twilio webhooks)'
$token = $envVals['TWILIO_AUTH_TOKEN']
$public = $envVals['PUBLIC_BASE_URL']
$r = Invoke-Twilio '/twilio/sms' @{ From = '+91' + (Phone 4); Body = 'JOIN' } 'x' $Base 'forged-signature'
Check 'Forged Twilio request is rejected (403)' ($r.Status -eq 403) $r.Text
if ($token -and $public) {
  $sp = '+91' + (Phone 5)
  $r = Invoke-Twilio '/twilio/sms' @{ From = $sp; Body = 'join' } $token $public
  Check 'SMS "join" creates an account' ($r.Status -eq 200 -and $r.Text -match 'Welcome to PhoneMail') $r.Text
  $r = Invoke-Twilio '/twilio/sms' @{ From = $sp; Body = 'JOIN' } $token $public
  Check 'Second JOIN says the account exists' ($r.Text -match 'already have') $r.Text
  $vp = '+91' + (Phone 6)
  $r = Invoke-Twilio '/twilio/voice' @{ From = $vp; CallSid = "CA$run" } $token $public
  Check 'Call: menu asks to press 1' ($r.Text -match '<Gather' -and $r.Text -match 'press 1') $r.Text
  $r = Invoke-Twilio '/twilio/voice/menu' @{ From = $vp; Digits = '1' } $token $public
  Check 'Pressing 1 creates the account and reads the address' ($r.Text -match 'Your account is ready') $r.Text
} else {
  Write-Host '  SKIP  signed webhooks: set TWILIO_AUTH_TOKEN and PUBLIC_BASE_URL in .env' -ForegroundColor Yellow
}

Section 'App login, data export and account deletion'
$dPhone = Phone 4
$app = New-Client
$start = Invoke-Api $app POST '/api/auth/otp/start' @{ phone = $dPhone }
$v = Invoke-Api $app POST '/api/auth/otp/verify' @{ phone = $dPhone; code = (Get-OtpCode $start.Json.phone); client = 'mobile' }
Check 'An app login gets a token, not a cookie' ($v.Status -eq 201 -and $v.Json.token) $v.Text
$bearer = @{ Authorization = "Bearer $($v.Json.token)" }
$tokenClient = New-Client  # no cookies: only the token identifies it
$r = Invoke-Api $tokenClient POST '/api/mail/messages' @{ to = @{ address = $A.User.address }; subject = 'From the app'; body_text = 'Sent with a token' } $bearer -NoCsrf
Check 'The token works for sending (no CSRF header needed)' ($r.Status -eq 201) $r.Text
$appMsg = $r.Json.message_id
$r = Invoke-Api $A.Client GET '/api/me/export'
Check "A downloads their data: account and messages in one JSON file" ($r.Status -eq 200 -and $r.Json.account.phone -eq $A.Phone -and @($r.Json.messages | Where-Object { $_.id -eq $appMsg }).Count -eq 1) "$($r.Status)"
$r = Invoke-Api $tokenClient PUT '/api/me/password' @{ new_password = 'app user password' } $bearer -NoCsrf
$r = Invoke-Api $tokenClient DELETE '/api/me' @{ password = 'wrong password' } $bearer -NoCsrf
Check 'Deleting the account needs the right password' ($r.Status -eq 401) $r.Text
$r = Invoke-Api $tokenClient DELETE '/api/me' @{ password = 'app user password' } $bearer -NoCsrf
Check 'The app user deletes their account' ($r.Status -eq 200) $r.Text
$r = Invoke-Api $tokenClient GET '/api/me' $null $bearer
Check 'Its token stops working' ($r.Status -eq 401) $r.Text
$r = Invoke-Api $A.Client GET "/api/mail/messages/$appMsg"
Check "A keeps the mail, now from 'Deleted account'" ($r.Status -eq 200 -and $r.Json.sender.display_name -eq 'Deleted account' -and $r.Json.body_text -eq 'Sent with a token') $r.Text

Section 'Logout'
$r = Invoke-Api $A.Client POST '/api/auth/logout' @{}
Check 'Logout (200)' ($r.Status -eq 200) $r.Text
$r = Invoke-Api $A.Client GET '/api/me'
Check 'After logout /api/me is 401' ($r.Status -eq 401) $r.Text
$r = Invoke-Api $B.Client GET '/api/me'
Check "B is still logged in (logout only affects A)" ($r.Status -eq 200) $r.Text

Write-Host ''
if ($script:failed -eq 0) {
  Write-Host "ALL $($script:passed) CHECKS PASSED" -ForegroundColor Green
  exit 0
}
Write-Host "$($script:failed) FAILED, $($script:passed) passed" -ForegroundColor Red
exit 1
