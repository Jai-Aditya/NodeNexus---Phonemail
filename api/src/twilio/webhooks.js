// Account creation by phone, as the brief asks:
//   * call the toll-free number and press 1   -> POST /twilio/voice, then /twilio/voice/menu
//   * text JOIN to the number                 -> POST /twilio/sms
// Point your Twilio number's "A call comes in" and "A message comes in" webhooks at these URLs.
//
// Twilio signs every webhook. We check the signature so nobody else can create accounts
// by POSTing here. The signature covers the full public URL, so PUBLIC_BASE_URL must be
// exactly the address Twilio calls (e.g. https://abcd.ngrok.app).
//
// Credentials are never spoken on a call: caller ID can be faked, so anything secret goes
// by SMS to the number, which only the real owner receives.

import { readForm, ApiError } from '../http/util.js';
import { normalizePhone, addressOf, maskPhone } from '../auth/phone.js';
import { validTwilioSignature } from './client.js';
import { hashPassword, temporaryPassword } from '../auth/password.js';

const JOIN_WORDS = new Set(['JOIN', 'REGISTER', 'SIGNUP', 'SIGN UP', '1']);

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

function sendTwiml(res, body) {
  const doc = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`;
  res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(doc) });
  res.end(doc);
}

/** "9876543210@phonemail.com" read out slowly: "9 8 7 6 5 4 3 2 1 0 at phonemail dot com". */
function speakable(address) {
  const [local, domain] = address.split('@');
  return `${local.split('').join(' ')}, at ${domain.replace(/\./g, ' dot ')}`;
}

export function twilioRoutes(router, { cfg, accounts, twilio, limiter }) {
  const say = (text) => `<Say voice="alice" language="en-IN">${xml(text)}</Say>`;

  /** Reads the form body and rejects the request unless Twilio signed it. */
  async function twilioForm(req) {
    const form = await readForm(req);
    if (!cfg.twilio.validateSignature) return form;
    const base = cfg.publicBaseUrl
      || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    if (!validTwilioSignature(cfg.twilio.authToken, base + req.url, form, req.headers['x-twilio-signature'])) {
      console.warn(`rejected unsigned Twilio webhook ${req.url}`);
      throw new ApiError(403, 'bad_signature', 'Invalid Twilio signature.');
    }
    return form;
  }

  /**
   * Creates (or finds) the account for this number and returns the text to send back.
   * In password mode a new account (or one that never set a password) gets a temporary password.
   */
  async function signUp(from, via) {
    const phone = normalizePhone(from, cfg.defaultCountryCode);
    limiter.hit(`phone-signup:${phone}`, 5, 3600, 'Too many sign-up attempts.');
    const { id, created } = await accounts.findOrCreate(phone, via);
    const address = addressOf(phone, cfg.mailDomain);
    const where = cfg.publicBaseUrl ? ` at ${cfg.publicBaseUrl}` : '';
    console.log(`${created ? 'created' : 'found'} account for ${maskPhone(phone)} via ${via}`);

    let text = created
      ? `Welcome to PhoneMail! Your email address is ${address}.`
      : `You already have a PhoneMail account: ${address}.`;

    if (cfg.authMode === 'password') {
      const profile = await accounts.profile(id);
      if (!profile.has_password) {
        const temp = temporaryPassword();
        await accounts.setPassword(id, await hashPassword(temp));
        text += ` Your temporary password is ${temp} - please change it after you log in${where}.`;
      } else {
        text += ` Log in${where} with your number and password.`;
      }
    } else {
      text += ` Log in${where} with your number; we'll text you a code.`;
    }
    return { phone, address, created, text };
  }

  // 1. The call comes in: play the menu and wait for one key press.
  router.post('/twilio/voice', async (req, res) => {
    await twilioForm(req);
    sendTwiml(res,
      `<Gather numDigits="1" timeout="8" action="/twilio/voice/menu" method="POST">`
      + say('Welcome to PhoneMail, email for your phone number. To create your account, press 1.')
      + `</Gather>`
      + say('We did not get your choice. Goodbye.'));
  });

  // 2. The caller pressed a key.
  router.post('/twilio/voice/menu', async (req, res) => {
    const form = await twilioForm(req);
    if (form.Digits !== '1') {
      return sendTwiml(res, say('Sorry, that is not an option.') + '<Redirect method="POST">/twilio/voice</Redirect>');
    }
    let result;
    try {
      result = await signUp(form.From, 'ivr');
    } catch (err) {
      console.error(`IVR sign-up failed for ${form.From ? maskPhone(String(form.From)) : 'unknown'}: ${err.message}`);
      return sendTwiml(res, say('Sorry, we could not create an account for this number. Goodbye.') + '<Hangup/>');
    }
    // Text the details (and any temporary password); the call only reads out the address.
    twilio.sendSms(result.phone, result.text).catch((err) => console.error(`sign-up SMS failed: ${err.message}`));
    sendTwiml(res,
      say(result.created ? 'Your account is ready.' : 'You already have an account.')
      + say(`Your email address is ${speakable(result.address)}.`)
      + say('We have sent you a text message with the details. Goodbye.')
      + '<Hangup/>');
  });

  // Text message: JOIN (or REGISTER / SIGNUP / 1) creates the account; the reply carries the details.
  router.post('/twilio/sms', async (req, res) => {
    const form = await twilioForm(req);
    const word = String(form.Body || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!JOIN_WORDS.has(word)) {
      return sendTwiml(res, `<Message>${xml('PhoneMail: reply JOIN to create your email account.')}</Message>`);
    }
    try {
      const { text } = await signUp(form.From, 'sms');
      sendTwiml(res, `<Message>${xml(text)}</Message>`);
    } catch (err) {
      console.error(`SMS sign-up failed: ${err.message}`);
      const msg = err instanceof ApiError && err.status !== 500 ? err.message : 'Something went wrong. Please try again later.';
      sendTwiml(res, `<Message>${xml(`PhoneMail: ${msg}`)}</Message>`);
    }
  });
}
