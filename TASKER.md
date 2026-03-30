# Tasker OTP Capture

This setup avoids scraping WhatsApp Web. Tasker reads the GetTransfer OTP from Android notifications or SMS and posts it to your machine.

## Local Receiver

Start the receiver on your computer:

```bash
cd /home/creamer/Downloads/claude/gettransfer
node ./src/otp-receiver.js
```

Or:

```bash
npm run otp:listen
```

Default endpoint:

- `POST http://100.104.170.88:8765/otp`
- health check: `GET http://100.104.170.88:8765/health`
- latest code: `GET http://100.104.170.88:8765/otp`

The latest OTP is written to:

- [`.latest-otp.json`](/home/creamer/Downloads/claude/gettransfer/.latest-otp.json)

Your phone and computer do not need to be on the same LAN if both are on Tailscale. This setup is now aimed at the tailnet address `100.104.170.88`.

## Recommended Tasker Setup

Recommended apps:

- `Tasker`
- `AutoNotification` plugin

AutoNotification is more reliable than Tasker’s basic notification event because it exposes cleaner WhatsApp notification fields.

## WhatsApp Profile

Create a new profile:

1. `Event`
2. `Plugin`
3. `AutoNotification`
4. `Intercept`

Suggested filter settings:

- App: `WhatsApp`
- Title Filter: `GetTransfer Support Team`
- Text Filter: `is your verification code.`

The observed sender details are:

- sender name: `GetTransfer Support Team`
- sender number: `+1 (276) 500-0405`
- message format: `4543 is your verification code.`

## Task

Create a task with these actions.

### 1. Build Notification Text

- `Variable Set`
- Name: `%gt_text`
- To: `%antextbig`

- `Variable Set`
- Name: `%gt_title`
- To: `%antitle`

Then:

- `If`
- Condition: `%gt_text ~ ^$`

Inside the `If`:

- `Variable Set`
- Name: `%gt_text`
- To: `%antext`

End the `If`.

### 2. Tighten Sender Validation

- `If`
- Condition: `%gt_title !~R (?i)(GetTransfer Support Team|\\+?1\\s*\\(?276\\)?\\s*500[- ]?0405)`

Inside:

- `Stop`

End the `If`.

### 3. Extract the OTP

- `Variable Search Replace`
- Variable: `%gt_text`
- Search: `(?<!\d)(\d{4,8})\s+is your verification code\.`
- Replace Matches: `Off`
- Store Matches In Array: `%otp`
- Regex: `On`

The OTP will be `%otp1`.

### 4. Ignore Non-Matches

- `If`
- Condition: `%otp1 !Set`

Inside:

- `Stop`

End the `If`.

### 5. Optional Local Feedback

- `Notify`
- Title: `GetTransfer OTP`
- Text: `%otp1`

Or:

- `Set Clipboard`
- Text: `%otp1`

### 6. Send to Your Computer

Add `HTTP Request`:

- Method: `POST`
- URL: `http://100.104.170.88:8765/otp`
- Headers: `Content-Type: application/json`
- Body:

```json
{
  "source": "tasker_whatsapp",
  "notification_text": "%gt_text",
  "notification_title": "%gt_title",
  "ts": "%TIMEMS"
}
```

If your Tasker version does not support JSON body easily, plain text also works:

- Method: `POST`
- URL: `http://100.104.170.88:8765/otp`
- Body: `%gt_title
%gt_text`

## SMS Profile

If GetTransfer sends the code by SMS instead of WhatsApp, add a second profile.

Create a new profile:

1. `Event`
2. `Phone`
3. `Received Text`

Suggested filter settings:

- Sender: leave blank unless you confirm the exact SMS sender id
- Content: `GetTransfer.com`

Link it to a second task, or reuse the same task shape with SMS variables.

### 1. Build SMS Text

- `Variable Set`
- Name: `%gt_text`
- To: `%evtprm3`

- `Variable Set`
- Name: `%gt_title`
- To: `%evtprm2`

On many Tasker builds for `Received Text`:

- `%evtprm2` is the sender / originating address
- `%evtprm3` is the SMS body

If your phone shows different parameter positions, use Tasker’s test run once and adjust those two variables.

### 2. Extract the OTP

- `Variable Search Replace`
- Variable: `%gt_text`
- Search: `(?i)(?:your login code:\s*|(?<!\d))(\d{4,8})(?:\s+is your verification code\.|\s+GetTransfer\.com)`
- Replace Matches: `Off`
- Store Matches In Array: `%otp`
- Regex: `On`

### 3. Ignore Non-Matches

- `If`
- Condition: `%otp1 !Set`

Inside:

- `Stop`

End the `If`.

### 4. Send to Your Computer

Add `HTTP Request`:

- Method: `POST`
- URL: `http://100.104.170.88:8765/otp`
- Headers: `Content-Type: application/json`
- Body:

```json
{
  "source": "tasker_sms",
  "notification_text": "%gt_text",
  "notification_title": "%gt_title",
  "ts": "%TIMEMS"
}
```

If you do know the exact SMS sender later, also add a Tasker-side `If` guard, for example:

- `If`
- Condition: `%gt_title ~R (?i)(GetTransfer|\\+?1\\s*\\(?276\\)?\\s*500[- ]?0405)`

Inside:

- keep going

Else:

- `Stop`

End the `If`.

## Testing

On your computer:

```bash
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/otp
```

Expected behavior:

- health returns `{"ok": true}`
- latest OTP returns the last captured code after a WhatsApp or SMS message arrives

## Notes

- Notification access must be granted to Tasker/AutoNotification.
- WhatsApp message previews must be enabled on the phone, otherwise the OTP may not appear in the notification text.
- For SMS, Tasker’s `Received Text` event does not need AutoNotification.
- If you want, the next step is to wire [gettransfer.js](/home/creamer/Downloads/claude/gettransfer/src/gettransfer.js) to wait on [`.latest-otp.json`](/home/creamer/Downloads/claude/gettransfer/.latest-otp.json) instead of Gmail IMAP.
