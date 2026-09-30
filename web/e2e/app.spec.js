// End-to-end: three people use the web client in real browsers against the real api and mail
// service. Screenshots of each main screen go to e2e/screenshots/.
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(shots, { recursive: true });
const run = String(Date.now() % 100000).padStart(5, '0');
const number = (n) => `7${run}${String(n).padStart(4, '0')}`; // 10 digits, new every run
const DOMAIN = process.env.MAIL_DOMAIN || 'phonemail.com'; // the server's mail domain
const DESKTOP = { width: 1366, height: 860 };
const PHONE = { width: 390, height: 844 };

const codesSeen = new Map(); // number -> codes already used, so a new one is awaited
const lastCodeAt = new Map(); // number -> when its last code was requested (the api allows one per 30 s)

/** The next sign-in code the api prints for this number (AUTH_MODE=console). */
async function codeFor(digits) {
  const pattern = new RegExp(`code for \\+91${digits}: (\\d{6})`, 'g');
  const seen = codesSeen.get(digits) || 0;
  for (let i = 0; i < 40; i++) {
    // CODES_CMD reads the api log elsewhere, e.g. over SSH when testing a server.
    const log = execSync(process.env.CODES_CMD || 'docker compose logs api --since 15m', { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
    const all = [...log.matchAll(pattern)];
    if (all.length > seen) {
      codesSeen.set(digits, all.length);
      return all[all.length - 1][1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no new code for ${digits} in the api log (AUTH_MODE=console?)`);
}

/** Waits until this number may ask for another code (one per 30 seconds). */
async function codeAllowed(digits) {
  const wait = (lastCodeAt.get(digits) || 0) + 31_000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCodeAt.set(digits, Date.now());
}

async function shot(page, name) {
  await page.waitForTimeout(250); // let transitions settle
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** Signs a new number up through the real screens: language, number, code. */
async function signUp(browser, digits, name, viewport = DESKTOP, colorScheme = 'light') {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByRole('button', { name: /English/ }).click();
  await expect(page.getByRole('heading', { name: /Sign in to PhoneMail/ })).toBeVisible();
  await page.locator('#phone').fill(digits);
  await codeAllowed(digits);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#secret')).toBeEnabled();
  await page.locator('#secret').fill(await codeFor(digits));
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  // Undo send is off for the test people, so Send is immediate (one test turns it on).
  await page.evaluate((n) => fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'e2e' },
    body: JSON.stringify(n ? { display_name: n, undo_send_seconds: 0 } : { undo_send_seconds: 0 }) }), name);
  await page.reload();
  return { context, page, digits, address: `${digits}@${DOMAIN}` };
}

async function compose(page, { to, subject, body, group }) {
  await page.getByRole('button', { name: 'Compose' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New email' });
  await dialog.locator('#c-to').fill(to);
  if (group) await dialog.getByLabel('Group name').fill(group);
  if (subject) await dialog.locator('#c-subject').fill(subject);
  await dialog.getByLabel('Message').fill(body);
  return dialog;
}

test.describe.serial('PhoneMail web client', () => {
  let A, B, C;

  test('first visit: language screen with Hindi and Tamil shown but not selectable', async ({ browser }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole('button', { name: /English/ })).toBeEnabled();
    await expect(page.getByRole('button', { name: /Hindi/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Tamil/ })).toBeDisabled();
    await shot(page, '01-language');
    await page.getByRole('button', { name: /English/ }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('By signing up, you agree to the')).toBeVisible();
    await page.locator('#phone').fill('98765');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('alert')).toContainText('10-digit');
    await page.locator('#phone').fill('9876543210');
    await expect(page.getByText(`Your address: 9876543210@${DOMAIN}`)).toBeVisible();
    await shot(page, '02-sign-in');
    await context.close();
  });

  test('three people sign up with a code', async ({ browser }) => {
    A = await signUp(browser, number(1), 'Asha Rao');
    B = await signUp(browser, number(2), 'Ravi Kumar');
    C = await signUp(browser, number(3), 'Meena Iyer');
    await expect(A.page.getByText('No mail yet')).toBeVisible();
    await shot(A.page, '03-empty-inbox');
  });

  test('A emails B; B sees it arrive live, reads it, replies once', async () => {
    await B.page.goto('/');
    const dialog = await compose(A.page, { to: B.digits, subject: 'Lunch on Friday?', body: 'Shall we try the new place near the station?' });
    await shot(A.page, '04-compose');
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(A.page.getByText('Sent', { exact: true })).toBeVisible();
    await expect(A.page).toHaveURL(/\/c\/\d+$/);

    // B's inbox updates by itself (live stream), with the unread badge.
    const row = B.page.locator('.chat-row', { hasText: 'Asha Rao' });
    await expect(row).toBeVisible();
    await expect(row.locator('.badge')).toHaveText('1');
    await shot(B.page, '05-inbox-unread');
    await row.click();
    await expect(B.page.getByText('Shall we try the new place near the station?')).toBeVisible();
    await B.page.getByRole('button', { name: 'Reply' }).click();
    await B.page.getByLabel('Reply').fill('Yes! 1 pm works for me.');
    await B.page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(B.page.getByText('Yes! 1 pm works for me.')).toBeVisible();
    // Reply once per email: the button is now "Replied" and disabled.
    // The email replied to stays open (what you opened stays open), now showing "Replied".
    const original = B.page.locator('.gthread', { hasText: 'Lunch on Friday?' }).locator('.mail-card').first();
    await expect(original).toHaveClass(/open/);
    await expect(original.getByRole('button', { name: 'Replied' })).toBeDisabled();
    await shot(B.page, '06-conversation');
  });

  test('long emails show a 100-character preview until opened', async () => {
    const long = 'This is a long update about the trip. '.repeat(12).trim();
    const dialog = await compose(A.page, { to: B.digits, subject: 'Trip notes', body: long });
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await B.page.goto('/');
    await B.page.locator('.chat-row', { hasText: 'Asha Rao' }).click();
    const card = B.page.locator('.gthread', { hasText: 'Trip notes' }).locator('.mail-card').last();
    await expect(card.getByRole('button', { name: 'Read more' })).toBeVisible();
    const preview = await card.locator('.mail-text').innerText();
    expect(preview.length).toBeLessThanOrEqual(101);
    expect(preview.endsWith('…')).toBe(true);
    await card.getByRole('button', { name: 'Read more' }).click();
    await expect(card.locator('.mail-html')).toHaveText(long);
  });

  test('two people in To need a group name; the group then has its own chat and activity lines', async () => {
    const dialog = await compose(A.page, { to: `${B.digits}, ${C.digits}`, subject: 'Goa plan', body: 'Dates?' });
    await expect(dialog.getByText('2 people in To start a new group')).toBeVisible();
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Name the new group');
    await dialog.getByLabel('Group name').fill(`Goa crew ${run}`);
    await shot(A.page, '07-compose-group');
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(A.page.getByText('Sent', { exact: true })).toBeVisible();
    await expect(A.page.locator('.event-line', { hasText: 'You created the group' })).toBeVisible();

    await C.page.goto('/');
    await C.page.locator('.chat-row', { hasText: `Goa crew ${run}` }).click();
    await expect(C.page.locator('.event-line', { hasText: 'Asha Rao created the group' })).toBeVisible();
    await expect(C.page.getByText('Dates?')).toBeVisible();

    // The same people and name again: pointed to the existing group, sent there by name.
    const again = await compose(A.page, { to: `${C.digits}, ${B.digits}`, group: `Goa crew ${run}`, body: 'Also: budget?' });
    await again.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(again.getByRole('alert')).toContainText('You already have the group');
    await again.getByRole('button', { name: /Send to “Goa crew/ }).click();
    await again.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(A.page.getByText('Also: budget?')).toBeVisible();
  });

  test('group admin tools: add, make admin; members see the lines', async () => {
    const D = await signUp(A.page.context().browser(), number(4), 'Dev Shah');
    await A.page.getByRole('button', { name: 'Group info' }).click();
    const sheet = A.page.getByRole('complementary', { name: 'Group info' });
    // The add box searches like Compose: a stranger shows up by their exact number.
    await sheet.getByLabel('Add member').fill(D.digits);
    await sheet.getByRole('option', { name: /Dev Shah/ }).click();
    await expect(sheet.getByLabel('Add member')).toHaveValue(`${D.address}, `);
    await sheet.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(sheet.getByText('Dev Shah')).toBeVisible();
    await sheet.locator('li', { hasText: 'Ravi Kumar' }).getByRole('button', { name: 'Make admin' }).click();
    await expect(sheet.locator('li', { hasText: 'Ravi Kumar' }).getByText('Admin')).toBeVisible();
    await shot(A.page, '08-group-info');
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(A.page.locator('.event-line', { hasText: 'You added Dev Shah' })).toBeVisible();
    await expect(A.page.locator('.event-line', { hasText: 'You made Ravi Kumar an admin' })).toBeVisible();
    // A new member doesn't see the group's earlier emails.
    await D.page.goto('/');
    await D.page.locator('.chat-row', { hasText: `Goa crew ${run}` }).click();
    await expect(D.page.locator('.event-line', { hasText: 'Asha Rao added you' })).toBeVisible();
    await expect(D.page.getByText('Dates?')).toHaveCount(0);
    await D.context.close();
  });

  test('attachments upload with the draft and download for the recipient', async () => {
    const dialog = await compose(A.page, { to: B.digits, subject: 'Minutes', body: 'Attached.' });
    await dialog.locator('#c-files').setInputFiles({ name: 'minutes.txt', mimeType: 'text/plain', buffer: Buffer.from('Minutes of the meeting\n') });
    await expect(dialog.locator('.att-chip[data-state="done"]')).toBeVisible();
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await B.page.goto('/?f=attachments');
    await B.page.locator('.chat-row', { hasText: 'Asha Rao' }).click();
    const link = B.page.locator('.gthread', { hasText: 'Minutes' }).getByRole('link', { name: /minutes\.txt/ });
    await expect(link).toBeVisible();
    const res = await B.page.request.get(await link.getAttribute('href'));
    expect(await res.text()).toBe('Minutes of the meeting\n');
  });

  test('files can be attached when replying or writing inside a conversation', async () => {
    await B.page.goto('/');
    await B.page.locator('.chat-row', { hasText: 'Asha Rao' }).click();
    const trip = B.page.locator('.gthread', { hasText: 'Trip notes' });
    await trip.locator('.mail-card').last().getByRole('button', { name: 'Reply' }).click();
    const writer = B.page.locator('.writer');
    await writer.locator('input[type=file]').setInputFiles({ name: 'itinerary.txt', mimeType: 'text/plain', buffer: Buffer.from('Day 1: beach\n') });
    await expect(writer.locator('.att-chip[data-state="done"]')).toBeVisible();
    await writer.getByRole('textbox', { name: 'Reply' }).fill('Itinerary attached');
    await shot(B.page, '21-reply-with-file');
    await writer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(trip.getByRole('link', { name: /itinerary\.txt/ })).toBeVisible();

    // A new email in the conversation with only a file (no text).
    await B.page.getByRole('button', { name: 'New email in this conversation' }).click();
    await writer.getByPlaceholder('Subject').fill('Just the map');
    await writer.locator('input[type=file]').setInputFiles({ name: 'map.txt', mimeType: 'text/plain', buffer: Buffer.from('North is up\n') });
    await expect(writer.locator('.att-chip[data-state="done"]')).toBeVisible();
    await writer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(B.page.locator('.gthread', { hasText: 'Just the map' }).getByRole('link', { name: /map\.txt/ })).toBeVisible();

    // Asha receives both, in the right threads, and the files download.
    await A.page.goto('/');
    await A.page.locator('.chat-row', { hasText: 'Ravi Kumar' }).first().click();
    const link = A.page.locator('.gthread', { hasText: 'Trip notes' }).getByRole('link', { name: /itinerary\.txt/ });
    await expect(link).toBeVisible();
    expect(await (await A.page.request.get(await link.getAttribute('href'))).text()).toBe('Day 1: beach\n');
    await expect(A.page.locator('.gthread', { hasText: 'Just the map' }).getByRole('link', { name: /map\.txt/ })).toBeVisible();

    // A cancelled reply leaves no draft behind.
    await A.page.locator('.gthread', { hasText: 'Just the map' }).getByRole('button', { name: 'Reply' }).click();
    await A.page.locator('.writer input[type=file]').setInputFiles({ name: 'oops.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    await expect(A.page.locator('.writer .att-chip[data-state="done"]')).toBeVisible();
    await A.page.locator('.writer').getByRole('button', { name: 'Discard' }).click();
    await A.page.getByRole('link', { name: 'Drafts' }).click();
    await expect(A.page.getByText('No drafts')).toBeVisible();
  });

  test('unsent writing waits in its conversation (WhatsApp-style); conversations open at the newest email', async () => {
    const group = `Goa crew ${run}`;
    await A.page.goto('/');
    await A.page.locator('.chat-row', { hasText: group }).click();
    // Opens at the bottom: the newest email is in view, with the writing box under it.
    const box = A.page.locator('.content');
    await expect.poll(() => box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4);
    await expect(A.page.getByRole('button', { name: 'New email in this conversation' })).toBeInViewport();

    // Start a reply with a file, then leave without sending.
    const newest = A.page.locator('.gthread').last().locator('.mail-card').last();
    const answered = await newest.getAttribute('data-id');
    await newest.getByRole('button', { name: 'Reply' }).click();
    await A.page.getByRole('textbox', { name: 'Reply' }).fill('Half a thought about the budget');
    await A.page.locator('.writer input[type=file]').setInputFiles({ name: 'budget.txt', mimeType: 'text/plain', buffer: Buffer.from('1000') });
    await expect(A.page.locator('.writer .att-chip[data-state="done"]')).toBeVisible();
    await A.page.waitForTimeout(1300); // autosave
    await A.page.getByRole('button', { name: 'Back' }).click();

    // The chat list says so; the Drafts folder doesn't hold it.
    const row = A.page.locator('.chat-row', { hasText: group });
    await expect(row.locator('.draft-tag')).toHaveText('Draft:');
    await expect(row).toContainText('Half a thought about the budget');
    await shot(A.page, '22-inbox-draft');
    await A.page.getByRole('link', { name: 'Drafts' }).click();
    await expect(A.page.locator('.chat-row', { hasText: 'Half a thought' })).toHaveCount(0);

    // Back in the conversation it's all there, still a reply to the same email.
    await A.page.goto('/');
    await A.page.locator('.chat-row', { hasText: group }).click();
    await expect(A.page.getByRole('textbox', { name: 'Reply' })).toHaveText('Half a thought about the budget');
    await expect(A.page.locator('.writer .att-chip', { hasText: 'budget.txt' })).toBeVisible();
    await expect(A.page.locator('.writer-label')).toContainText('Replying to');
    await shot(A.page, '23-conversation-draft');
    await A.page.getByRole('button', { name: 'Send', exact: true }).click();
    const sent = A.page.locator('.mail-card', { hasText: 'Half a thought about the budget' });
    await expect(sent).toBeVisible();
    await expect(sent.getByRole('link', { name: /budget\.txt/ })).toBeVisible();
    const replyCard = A.page.locator('.mail-card', { hasText: 'Half a thought about the budget' });
    await expect(replyCard.locator('.quote')).toHaveCount(0); // a reply to the email just above it (not a stray new email)
    expect(answered).toBeTruthy();
    await A.page.goto('/');
    await expect(A.page.locator('.chat-row', { hasText: group }).locator('.draft-tag')).toHaveCount(0);
  });

  test('star, Trash and back; search finds mail, people and groups', async () => {
    await B.page.goto('/');
    await B.page.locator('.chat-row', { hasText: 'Asha Rao' }).click();
    const card = B.page.locator('.gthread', { hasText: 'Minutes' }).locator('.mail-card').last();
    await card.getByRole('button', { name: 'Star' }).click();
    await B.page.goto('/?f=favorites');
    await expect(B.page.locator('.chat-row', { hasText: 'Asha Rao' })).toBeVisible();
    await B.page.locator('.chat-row', { hasText: 'Asha Rao' }).click();
    await B.page.locator('.gthread', { hasText: 'Minutes' }).locator('.mail-card').last().getByRole('button', { name: 'Delete' }).click();
    await B.page.goto('/trash');
    await B.page.locator('.chat-row', { hasText: 'Minutes' }).click();
    await B.page.getByRole('button', { name: 'Move to Inbox' }).click();
    await expect(B.page).toHaveURL(/\/c\/\d+$/);

    await B.page.getByLabel('Search mail').fill('lunch');
    await B.page.getByLabel('Search mail').press('Enter');
    await expect(B.page.getByRole('heading', { name: 'Emails' })).toBeVisible();
    await expect(B.page.locator('.chat-row', { hasText: 'Lunch on Friday?' }).first()).toBeVisible(); // the email and its reply (Re:)
    await B.page.getByLabel('Search mail').fill(`goa crew ${run}`);
    await B.page.getByLabel('Search mail').press('Enter');
    await expect(B.page.getByRole('heading', { name: 'Groups' })).toBeVisible();
    await shot(B.page, '09-search');
  });

  test('threads: Gmail-style blocks on desktop, nested Reddit-style on phones', async ({ browser }) => {
    const call = (page, method, url, body) => page.evaluate(([m, u, b]) => fetch(u, {
      method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'e2e' }, body: b && JSON.stringify(b),
    }).then((r) => r.json()), [method, url, body]);
    // A starts a thread; A and B reply to each other 6 levels deep; A adds a side reply to the start.
    const root = await call(A.page, 'POST', '/api/mail/messages', { to: { address: B.digits }, subject: 'Deep thread', body_text: 'Level 0' });
    const conv = root.conversation_ids[0];
    const ids = [root.message_id];
    for (let d = 1; d <= 6; d++) {
      const r = await call(d % 2 ? B.page : A.page, 'POST', `/api/mail/messages/${ids[d - 1]}/reply`, { conversation_id: conv, body_text: `Level ${d}` });
      ids.push(r.message_id);
    }
    const side = await call(A.page, 'POST', `/api/mail/messages/${root.message_id}/reply`, { conversation_id: conv, body_text: 'Side note' });

    // Desktop: one block, emails one below the other in time order, the middle folded.
    await A.page.goto(`/c/${conv}`);
    const block = A.page.locator('.gthread', { hasText: 'Deep thread' });
    await expect(block.getByText('8 emails')).toBeVisible();
    await block.getByRole('button', { name: '5 more emails' }).click();
    await expect(block.locator('.mail-card')).toHaveCount(8);
    const order = await block.locator('.mail-card').evaluateAll((cards) => cards.map((c) => Number(c.dataset.id)));
    expect(order).toEqual([...ids, side.message_id]);
    await shot(A.page, '17-threads-desktop');

    // Phone: nested under what each email answers, joined by lines.
    const pc = await browser.newContext({ viewport: PHONE, storageState: await B.context.storageState() });
    const pp = await pc.newPage();
    await pp.goto(`/c/${conv}`);
    const tree = pp.locator('.rthread', { hasText: 'Deep thread' });
    const node = (id) => tree.locator(`.rnode[data-id="${id}"]`);
    await expect(node(ids[1])).toHaveAttribute('data-depth', '1');
    await expect(node(side.message_id)).toHaveAttribute('data-depth', '1'); // a second branch of the start
    await expect(node(ids[4])).toHaveAttribute('data-depth', '4');
    await expect(tree.getByText('Level 5')).toHaveCount(0); // deeper than 4: behind "Continue"
    await node(ids[3]).scrollIntoViewIfNeeded();
    await shot(pp, '18-threads-phone');
    await tree.getByRole('button', { name: /Continue this thread/ }).click();
    await expect(tree.getByText('Level 6')).toBeVisible();
    await tree.getByRole('button', { name: 'Back to the whole thread' }).click();
    // Collapsing a reply hides everything under it.
    await node(ids[1]).locator('> .swipe .rnode-head .rnode-toggle').click();
    await expect(tree.getByText('Level 2')).toHaveCount(0);
    await expect(tree.getByText('Side note')).toBeVisible();
    await node(ids[1]).locator('> .swipe .rnode-head .rnode-toggle').click();
    await expect(tree.getByText('Level 2')).toBeVisible();
    // Reply from the phone: it appears nested under the email answered.
    await node(side.message_id).getByRole('button', { name: 'Reply' }).click();
    await pp.getByRole('textbox', { name: 'Reply' }).fill('Replying to the side note');
    await pp.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(node(side.message_id).locator('.rnode', { hasText: 'Replying to the side note' })).toHaveAttribute('data-depth', '2');
    await pc.close();
  });

  test('two groups with the same name: Compose asks which one, showing their members', async () => {
    const call = (page, method, url, body) => page.evaluate(([m, u, b]) => fetch(u, {
      method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'e2e' }, body: b && JSON.stringify(b),
    }).then((r) => r.json()), [method, url, body]);
    const name = `Buildathon ${run}`;
    const big = await call(A.page, 'POST', '/api/mail/groups', { name, members: [{ address: B.digits }, { address: C.digits }] });
    const small = await call(A.page, 'POST', '/api/mail/groups', { name, members: [{ address: B.digits }] });
    expect(big.conversation_id).not.toBe(small.conversation_id);

    const dialog = await compose(A.page, { to: name.toLowerCase(), subject: 'Which one?', body: 'Only for Ravi and me' });
    const choice = dialog.getByRole('group', { name: /You have 2 groups called/ });
    await expect(choice).toBeVisible();
    await expect(choice.getByText('with Ravi Kumar, Meena Iyer')).toBeVisible();
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Choose which group you mean');
    await choice.getByText('with Ravi Kumar', { exact: true }).click();
    await expect(dialog.getByText('with Ravi Kumar', { exact: false }).first()).toBeVisible();
    await shot(A.page, '19-compose-which-group');

    // The choice is kept in the draft.
    await dialog.getByRole('button', { name: 'Save draft and close' }).click();
    await expect(A.page.getByText('Saved to Drafts')).toBeVisible();
    await A.page.getByRole('link', { name: 'Drafts' }).click();
    await A.page.locator('.chat-row', { hasText: 'Which one?' }).click();
    const again = A.page.getByRole('dialog', { name: 'New email' });
    await expect(again.locator('#c-to')).toHaveValue(name);
    await expect(again.getByRole('group', { name: /You have 2 groups called/ })).toHaveCount(0);
    await again.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(A.page).toHaveURL(new RegExp(`/c/${small.conversation_id}$`));
    await expect(A.page.getByText('Only for Ravi and me')).toBeVisible();
  });

  test('Compose suggests recipients: contacts and groups as you type, strangers only by exact number', async ({ browser }) => {
    const name = `Buildathon ${run}`;
    // A contact, by the first letters of their name; picked with the keyboard.
    await A.page.getByRole('button', { name: 'Compose' }).first().click();
    const dialog = A.page.getByRole('dialog', { name: 'New email' });
    await dialog.locator('#c-to').pressSequentially('rav');
    const list = dialog.getByRole('listbox', { name: 'Suggestions' });
    await expect(list.getByRole('option', { name: /Ravi Kumar/ })).toBeVisible();
    await shot(A.page, '20-compose-suggestions');
    await dialog.locator('#c-to').press('Enter');
    await expect(dialog.locator('#c-to')).toHaveValue(`${B.address}, `);
    await dialog.getByRole('button', { name: 'Save draft and close' }).click();

    // Groups with the same name, told apart by their members; picked with the mouse.
    await A.page.getByRole('button', { name: 'Compose' }).first().click();
    await dialog.locator('#c-to').pressSequentially('buildathon');
    await expect(list.getByRole('option', { name: new RegExp(`${name}.*with Ravi Kumar, Meena Iyer`) })).toBeVisible();
    await list.getByRole('option', { name: new RegExp(`${name}.*with Ravi Kumar$`) }).click();
    await expect(dialog.locator('#c-to')).toHaveValue(`${name}, `);
    await expect(dialog.getByRole('group', { name: /You have 2 groups called/ })).toHaveCount(0); // already chosen
    await dialog.getByLabel('Message').fill('Picked from the suggestions');
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(A.page.getByText('Picked from the suggestions')).toBeVisible();
    await expect(A.page.locator('.thread-head')).toContainText('2 members'); // the smaller group: Asha and Ravi

    // Someone A has never written to: not found by part of the number, found by all of it.
    const E = await signUp(browser, number(7), 'Esha Stranger');
    await A.page.getByRole('button', { name: 'Compose' }).first().click();
    await dialog.locator('#c-to').pressSequentially(E.digits.slice(0, 6));
    await A.page.waitForTimeout(600);
    await expect(list.getByRole('option', { name: /Esha/ })).toHaveCount(0);
    await dialog.locator('#c-to').pressSequentially(E.digits.slice(6));
    const stranger = list.getByRole('option', { name: /Esha Stranger/ });
    await expect(stranger).toBeVisible();
    await expect(stranger).toContainText('no conversation yet');
    await stranger.click();
    await expect(dialog.locator('#c-to')).toHaveValue(`${E.address}, `);
    await dialog.getByRole('button', { name: 'Discard draft' }).click();
    await E.context.close();
  });

  test('closing an unsent email keeps it in Drafts', async () => {
    const dialog = await compose(A.page, { to: C.digits, subject: 'Half-written', body: 'I will finish this later' });
    await dialog.getByRole('button', { name: 'Save draft and close' }).click();
    await expect(A.page.getByText('Saved to Drafts')).toBeVisible();
    await A.page.getByRole('link', { name: 'Drafts' }).click();
    await expect(A.page.locator('.chat-row', { hasText: 'Half-written' })).toBeVisible();
    await A.page.locator('.chat-row', { hasText: 'Half-written' }).click();
    await expect(A.page.getByRole('dialog', { name: 'New email' }).locator('#c-subject')).toHaveValue('Half-written');
    await A.page.getByRole('dialog').getByRole('button', { name: 'Discard draft' }).click();
    await A.page.reload();
    await expect(A.page.locator('.chat-row', { hasText: 'Half-written' })).toHaveCount(0);
  });

  test('settings: name, alias, password, data download', async () => {
    await A.page.goto('/settings');
    await expect(A.page.getByRole('heading', { name: 'Profile and settings' })).toBeVisible();
    await expect(A.page.getByRole('radio', { name: /Hindi/ })).toBeDisabled();
    await A.page.getByLabel('New alias').fill(`asha${run}`);
    await A.page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(A.page.getByText(`asha${run}@${DOMAIN}`)).toBeVisible();
    await A.page.getByLabel('New password', { exact: true }).fill('asha secret 1');
    await A.page.getByLabel('New password again').fill('asha secret 1');
    await A.page.getByRole('button', { name: 'Set password' }).click();
    await expect(A.page.getByText('Password set')).toBeVisible();
    await shot(A.page, '10-settings');
    const download = A.page.waitForEvent('download');
    await A.page.getByRole('link', { name: 'Download my data' }).click();
    const file = await (await download).path();
    const data = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
    expect(data.account.address).toBe(A.address);
    expect(data.messages.length).toBeGreaterThan(3);
  });

  // ---- Gmail-style features (30 Sep) ----

  test('forward, mark as unread, archive and All mail', async () => {
    // Asha forwards her newest email with Ravi to Meena; its text goes along, quoted.
    await A.page.goto('/');
    await A.page.locator('.chat-row', { hasText: 'Ravi Kumar' }).first().click();
    await A.page.locator('.mail-card.open').last().getByRole('button', { name: 'Forward' }).click();
    const dialog = A.page.getByRole('dialog', { name: 'New email' });
    await expect(dialog.locator('#c-subject')).toHaveValue(/^Fwd: /);
    await expect(dialog.locator('#c-body')).toContainText('Forwarded message');
    await dialog.locator('#c-to').fill(C.digits);
    await shot(A.page, '30-forward');
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await C.page.goto('/');
    await expect(C.page.locator('.chat-row', { hasText: 'Asha Rao' })).toContainText('Forwarded message');

    // Ravi reads the chat, then marks it unread again: back to the list, with a badge.
    await B.page.goto('/');
    await B.page.locator('.chat-row', { hasText: 'Asha Rao' }).click();
    await B.page.getByRole('button', { name: 'More', exact: true }).click();
    await B.page.getByRole('menuitem', { name: 'Mark as unread' }).click();
    await expect(B.page).toHaveURL(/\/$/);
    const row = B.page.locator('.chat-row', { hasText: 'Asha Rao' });
    await expect(row.locator('.badge')).toHaveText('1');

    // Pick it with its tick box and archive it: it leaves the Inbox, Undo brings it back.
    await B.page.getByRole('checkbox', { name: 'Select Asha Rao' }).check();
    await expect(B.page.getByText('1 selected')).toBeVisible();
    await shot(B.page, '31-bulk-select');
    await B.page.getByRole('toolbar').getByRole('button', { name: 'Archive' }).click();
    await expect(B.page.getByText('Conversation archived')).toBeVisible();
    await expect(row).toHaveCount(0);
    await B.page.getByRole('button', { name: 'Undo' }).click();
    await expect(row).toBeVisible();

    // Keyboard: j moves to the first conversation, e archives it. All mail still has it.
    await B.page.evaluate(() => document.activeElement?.blur());
    await B.page.keyboard.press('j');
    await expect(B.page.locator('.chat-row.cursor')).toHaveCount(1);
    const href = await B.page.locator('.chat-row.cursor').getAttribute('href');
    const chat = B.page.locator(`.chat-row[href="${href}"]`);
    await B.page.keyboard.press('e');
    await expect(B.page.getByText('Conversation archived')).toBeVisible();
    await expect(chat).toHaveCount(0);
    await B.page.getByRole('link', { name: 'All mail' }).click();
    await expect(chat.locator('.label', { hasText: 'Archived' })).toBeVisible();
    await shot(B.page, '32-all-mail');
    await B.page.locator('li', { has: chat }).getByRole('checkbox').check();
    await B.page.getByRole('toolbar').getByRole('button', { name: 'Move to Inbox' }).click();
    await B.page.getByRole('link', { name: 'Inbox' }).click();
    await expect(chat).toBeVisible();
  });

  test('formatting, signature and undo send', async () => {
    await A.page.goto('/settings');
    await A.page.locator('#s-signature').fill('Asha Rao · Chennai');
    await A.page.getByRole('button', { name: 'Save signature' }).click();
    await expect(A.page.getByText('Signature saved')).toBeVisible();
    await A.page.locator('#s-undo').selectOption('5');
    await expect(A.page.getByText('Saved', { exact: true })).toBeVisible();

    // A new email starts with the signature; Bold makes the next words bold.
    await A.page.getByRole('button', { name: 'Compose' }).first().click();
    const dialog = A.page.getByRole('dialog', { name: 'New email' });
    await expect(dialog.locator('#c-body')).toContainText('Asha Rao · Chennai');
    await dialog.locator('#c-to').fill(B.digits);
    await dialog.locator('#c-subject').fill('Formatted');
    await dialog.locator('#c-body').click();
    await A.page.keyboard.press('Control+Home');
    await dialog.getByRole('button', { name: 'Bold' }).click();
    await A.page.keyboard.type('Important');
    await dialog.getByRole('button', { name: 'Bold' }).click();
    await A.page.keyboard.type(' and plain.');
    await shot(A.page, '33-formatting');

    // Send, then Undo: the email comes back into Compose, not sent.
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(A.page.locator('.toast')).toContainText('Sending…');
    await shot(A.page, '34-undo-send');
    await A.page.getByRole('button', { name: 'Undo' }).click();
    const back = A.page.getByRole('dialog', { name: 'New email' });
    await expect(back.locator('#c-subject')).toHaveValue('Formatted');
    await expect(back.locator('#c-body')).toContainText('Important and plain.');

    // Send for real this time: it goes when the 5 seconds are up.
    await back.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(A.page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 15_000 });
    await B.page.goto('/');
    await B.page.locator('.chat-row', { hasText: 'Asha Rao' }).click();
    const card = B.page.locator('.gthread', { hasText: 'Formatted' }).locator('.mail-card').last();
    await expect(card.locator('.mail-html b, .mail-html strong')).toHaveText('Important');
    await expect(card).toContainText('Asha Rao · Chennai');

    // Back to instant sending for the other tests.
    await A.page.evaluate(() => fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'e2e' }, body: JSON.stringify({ undo_send_seconds: 0 }) }));
    await A.page.reload();
  });

  test('schedule send and snooze', async () => {
    // Schedule an email for tomorrow morning; it waits under Scheduled until cancelled.
    const dialog = await compose(A.page, { to: B.digits, subject: 'For tomorrow', body: 'Good morning!' });
    await dialog.getByRole('button', { name: 'Schedule send' }).click();
    await shot(A.page, '35-schedule-send');
    await A.page.getByRole('menuitem', { name: /^Tomorrow morning/ }).click();
    await expect(A.page.getByText(/^Scheduled for/)).toBeVisible();
    await A.page.getByRole('link', { name: 'Scheduled' }).click();
    const row = A.page.locator('.chat-row', { hasText: 'For tomorrow' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Cancel send' }).click();
    const again = A.page.getByRole('dialog', { name: 'New email' });
    await expect(again.locator('#c-subject')).toHaveValue('For tomorrow');
    await again.getByRole('button', { name: 'Discard draft' }).click();
    await A.page.reload();
    await expect(A.page.locator('.chat-row', { hasText: 'For tomorrow' })).toHaveCount(0);

    // Ravi snoozes his chat with Asha until tomorrow: it moves to Snoozed.
    await B.page.goto('/');
    await B.page.locator('.chat-row', { hasText: 'Asha Rao' }).click();
    await B.page.getByRole('button', { name: 'Snooze' }).click();
    await B.page.getByRole('menuitem', { name: /^Tomorrow/ }).click();
    await expect(B.page).toHaveURL(/\/$/);
    await expect(B.page.locator('.chat-row', { hasText: 'Asha Rao' })).toHaveCount(0);
    await B.page.getByRole('link', { name: 'Snoozed' }).click();
    const snoozed = B.page.locator('.chat-row', { hasText: 'Asha Rao' });
    await expect(snoozed.locator('.snooze-label')).toContainText('Until');
    await shot(B.page, '36-snoozed');
    await B.page.getByRole('checkbox', { name: 'Select Asha Rao' }).check();
    await B.page.getByRole('button', { name: 'Unsnooze' }).click();
    await B.page.getByRole('link', { name: 'Inbox' }).click();
    await expect(B.page.locator('.chat-row', { hasText: 'Asha Rao' })).toBeVisible();
  });

  test('reactions, mute and block', async () => {
    // Ravi reacts to Asha's email; Asha sees it without reloading.
    await A.page.goto('/');
    await A.page.locator('.chat-row', { hasText: 'Ravi Kumar' }).first().click();
    await B.page.goto('/');
    await B.page.locator('.chat-row', { hasText: 'Asha Rao' }).click();
    const card = B.page.locator('.gthread', { hasText: 'Formatted' }).locator('.mail-card').last();
    await card.getByRole('button', { name: 'React', exact: true }).click();
    await B.page.getByRole('menuitem', { name: 'React with 👍' }).click();
    await expect(card.locator('.reaction.mine')).toContainText('👍 1');
    const theirs = A.page.locator('.gthread', { hasText: 'Formatted' }).locator('.reaction', { hasText: '👍' });
    await expect(theirs).toContainText('1');
    await expect(theirs).toHaveAttribute('title', 'Ravi Kumar');
    await shot(A.page, '37-reaction');

    // Mute: a note says so; unmute again.
    await B.page.getByRole('button', { name: 'More', exact: true }).click();
    await B.page.getByRole('menuitem', { name: 'Mute (no alerts)' }).click();
    await expect(B.page.locator('.notice', { hasText: 'Muted' })).toBeVisible();
    await B.page.getByRole('button', { name: 'More', exact: true }).click();
    await B.page.getByRole('menuitem', { name: 'Unmute' }).click();
    await expect(B.page.locator('.notice', { hasText: 'Muted' })).toHaveCount(0);

    // Block: Asha's next email lands in Ravi's Spam; unblocking from Settings.
    await B.page.getByRole('button', { name: 'More', exact: true }).click();
    await B.page.getByRole('menuitem', { name: 'Block Asha Rao' }).click();
    await expect(B.page.getByText(/Asha Rao is blocked/)).toBeVisible();
    const dialog = await compose(A.page, { to: B.digits, subject: 'Are you there?', body: 'Hello?' });
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(A.page.getByText('Sent', { exact: true })).toBeVisible();
    await B.page.goto('/spam');
    await expect(B.page.locator('.chat-row', { hasText: 'Are you there?' })).toBeVisible();
    await B.page.goto('/settings');
    const blocked = B.page.locator('.member-list li', { hasText: 'Asha Rao' });
    await expect(blocked).toBeVisible();
    await shot(B.page, '38-blocked');
    await blocked.getByRole('button', { name: 'Unblock' }).click();
    await expect(B.page.getByText("You haven't blocked anyone.")).toBeVisible();
  });

  test('search options, keyboard shortcuts and the attachment viewer', async () => {
    // Search options write the operators into the search.
    await A.page.goto('/');
    await A.page.getByRole('button', { name: 'Search options' }).click();
    const form = A.page.getByRole('form', { name: 'Search options' });
    await form.getByLabel('From').fill('Ravi Kumar');
    await form.getByLabel('Has attachment').check();
    await shot(A.page, '39-search-options');
    await form.getByRole('button', { name: 'Search' }).click();
    await expect(A.page).toHaveURL(/q=from%3A%22Ravi%20Kumar%22%20has%3Aattachment/);
    await expect(A.page.locator('.chat-row', { hasText: 'Just the map' })).toBeVisible();
    await expect(A.page.locator('.chat-row', { hasText: 'Lunch on Friday' })).toHaveCount(0);

    // Shortcuts: ? shows them, c opens Compose, / goes to search.
    await A.page.goto('/');
    await expect(A.page.locator('.chat-row').first()).toBeVisible(); // loaded: keys go to the app
    await A.page.keyboard.press('?');
    await expect(A.page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await A.page.keyboard.press('Escape');
    await A.page.keyboard.press('c');
    await expect(A.page.getByRole('dialog', { name: 'New email' })).toBeVisible();
    await A.page.getByRole('dialog', { name: 'New email' }).getByRole('button', { name: 'Save draft and close' }).click();
    await A.page.keyboard.press('/');
    await expect(A.page.getByRole('textbox', { name: 'Search mail' })).toBeFocused();

    // A picture and a PDF open in the viewer.
    const png = readFileSync(path.join(root, 'api', 'test', 'fixtures', 'plain.png'));
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj '
      + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const dialog = await compose(A.page, { to: B.digits, subject: 'Photos and plan', body: 'Have a look.' });
    await dialog.locator('#c-files').setInputFiles([
      { name: 'beach.png', mimeType: 'image/png', buffer: png },
      { name: 'plan.pdf', mimeType: 'application/pdf', buffer: pdf },
    ]);
    await expect(dialog.locator('.att-chip[data-state="done"]')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(A.page.getByText('Sent', { exact: true })).toBeVisible();
    await B.page.goto('/');
    await B.page.locator('.chat-row', { hasText: 'Asha Rao' }).click();
    await B.page.locator('.gthread', { hasText: 'Photos and plan' }).getByRole('button', { name: /beach\.png/ }).click();
    const viewer = B.page.getByRole('dialog', { name: 'beach.png' });
    await expect(viewer.locator('img.viewer-img')).toBeVisible();
    await shot(B.page, '40-viewer');
    await expect(viewer).toContainText(/[12]\/2/); // the other file is an arrow key away
    await B.page.keyboard.press('Escape');
    await B.page.locator('.gthread', { hasText: 'Photos and plan' }).getByRole('button', { name: /plan\.pdf/ }).click();
    const pdfView = B.page.getByRole('dialog', { name: 'plan.pdf' });
    await expect(pdfView.locator('iframe.viewer-pdf')).toHaveAttribute('src', /^blob:/);
    await B.page.waitForTimeout(1500);
    await shot(B.page, '41-viewer-pdf');
    await B.page.keyboard.press('Escape');
    await expect(pdfView).toHaveCount(0);
  });

  test('phone layout: chips, compose button, chat bubbles', async ({ browser }) => {
    const P = await signUp(browser, number(5), 'Priya Nair', PHONE);
    await expect(P.page.getByRole('tab', { name: 'Unread' })).toBeVisible();
    await expect(P.page.locator('.fab')).toBeVisible();
    // Write to Asha with the full-screen composer.
    await P.page.locator('.fab').click();
    const dialog = P.page.getByRole('dialog', { name: 'New email' });
    await dialog.locator('#c-to').fill(A.digits);
    await dialog.locator('#c-subject').fill('Hello from my phone');
    await dialog.getByLabel('Message').fill('Testing PhoneMail on a small screen.');
    await shot(P.page, '11-phone-compose');
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(P.page.locator('.rthread', { hasText: 'Hello from my phone' })).toBeVisible();
    await P.page.getByRole('button', { name: 'Write an email…' }).click();
    await P.page.getByLabel('Message').fill('And a second email in the same chat.');
    await P.page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(P.page.locator('.rthread')).toHaveCount(2); // a new email starts a new thread
    await shot(P.page, '12-phone-chat');
    // Swipe right on an email to reply to it (the brief's phone gesture).
    const box = await P.page.locator('.rthread', { hasText: 'Hello from my phone' }).locator('.swipe').first().boundingBox();
    const cdp = await P.context.newCDPSession(P.page);
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 20, y }] });
    for (const dx of [20, 50, 80, 110]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 20 + dx, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(P.page.locator('.writer-label')).toContainText('Replying to');
    await P.page.locator('.writer').getByRole('button', { name: 'Discard' }).click();
    await P.page.getByRole('button', { name: 'Back' }).click();
    await shot(P.page, '13-phone-inbox');
    // Dark theme, for the record.
    const dark = await browser.newContext({ viewport: PHONE, colorScheme: 'dark', storageState: await P.context.storageState() });
    const dp = await dark.newPage();
    await dp.goto('/');
    await shot(dp, '14-phone-inbox-dark');
    await dark.close();
    await P.context.close();
  });

  test('sign-up portal creates accounts without signing in, then clears', async ({ browser }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    await page.goto('/register/');
    await page.locator('#portal-phone').fill(number(6));
    await codeAllowed(number(6));
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.locator('#portal-otp')).toBeEnabled();
    await page.locator('#portal-otp').fill(await codeFor(number(6)));
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('status')).toContainText(`${number(6)}@${DOMAIN}`);
    await expect(page.locator('#portal-phone')).toHaveValue('');
    await shot(page, '15-portal');
    expect((await page.request.get('/api/me')).status()).toBe(401);
    await context.close();
  });

  test('forgot password: a code by SMS sets a new one', async ({ browser }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    await page.goto('/forgot');
    await page.getByPlaceholder('98765 43210').fill(A.digits);
    await codeAllowed(A.digits);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByPlaceholder('6-digit code').fill(await codeFor(A.digits));
    await page.getByLabel('New password', { exact: true }).fill('asha secret 2');
    await page.getByLabel('New password again').fill('asha secret 2');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
    await context.close();
    // Asha's other browser was signed out by the reset.
    await A.page.reload();
    await expect(A.page.getByRole('heading', { name: /Sign in to PhoneMail/ })).toBeVisible();
  });

  test('deleting an account: others keep its mail, from "Deleted account"', async () => {
    test.setTimeout(90_000); // waits out the one-code-per-30-seconds limit
    const dialog = await compose(C.page, { to: B.digits, subject: 'Before I go', body: 'Keep this one.' });
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(C.page.getByText('Sent', { exact: true })).toBeVisible(); // before leaving the page
    await C.page.goto('/settings');
    await C.page.getByRole('button', { name: 'Delete my account…' }).click();
    await codeAllowed(C.digits);
    await C.page.getByRole('button', { name: 'Send code' }).click();
    await C.page.getByLabel('Code').fill(await codeFor(C.digits));
    await C.page.getByRole('button', { name: 'Delete my account for good' }).click();
    await expect(C.page.getByRole('heading', { name: /Sign in to PhoneMail/ })).toBeVisible();

    await B.page.goto('/');
    const row = B.page.locator('.chat-row', { hasText: 'Deleted account' });
    await expect(row).toBeVisible();
    await row.click();
    await expect(B.page.getByText('Keep this one.')).toBeVisible();
    await expect(B.page.getByText('This person deleted their account')).toBeVisible();
    await expect(B.page.getByRole('button', { name: 'Reply' })).toHaveCount(0); // nobody to reply to
    await shot(B.page, '16-deleted-account');
  });
});
