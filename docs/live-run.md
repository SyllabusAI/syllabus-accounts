# The live-mode run (Oct 8)

One person, two Google accounts that have never used Syllabus, a real card,
and a Mac that has never had Syllabus on it. It goes through everything a
paying student does, in live mode, in order, and it is what the Oct 9 go or
slip reads. Plan on about 90 minutes and about $15 of real charges. Most of
the $9 plan comes back as a refund at the end; the $5 top-up does not.

Do it after the live swap (`docs/stripe-live.md`) is merged and deployed,
and with the signed DMG if Apple is through. Write each step's result in
the last column as you go; anything other than the expected result is a
finding, even if it looks small.

## Before you start

- [ ] `npx wrangler tail --format json > live-run.jsonl &` is running in this
      repo. It catches every log line of the run for step 15.
- [ ] Stripe dashboard open in **live** mode, on Payments.
- [ ] Test account A: a Google account with no Syllabus history. Test
      account B: a second one, for the code.

## The run

| # | Do | Expect | Result |
|---|---|---|---|
| 1 | On the clean Mac, download from maincoursemedia.com/syllabus/download/ and open it | Signed build: opens with no warning. Unsigned: the "Open Anyway" steps on the page work as written | |
| 2 | Sign in with Google as account A when the app asks | The browser shows the device approval page naming this Mac; approving it signs the app in. Setup says the Mac holds no API key | |
| 3 | On the account page, under Plans, trial, and billing, choose Starter | Stripe Checkout asks for a card and an address, shows tax, and says nothing is due today. Back on the account page: free trial, 5 hours | |
| 4 | Set a class schedule with a class starting now, connect Google Drive (Connect Google Drive, tick the Drive box) | Google Drive shows Connected with account A's Gmail address | |
| 5 | Record 10 minutes of a real lecture (a recorded one played aloud is fine), then stop | Within a few minutes a Google Doc summary is in Drive under Lecture Notes, in that course's folder, with the transcript one level down. The local audio is gone | |
| 6 | Drop a short phone recording into the inbox folder | It is picked up, filed under the course its time matches, and summarized like step 5 | |
| 7 | End the trial from Stripe instead of recording 5 hours: in the live dashboard, open account A's subscription and end the trial now | Stripe charges Starter ($9 plus tax) to the card. Within a minute the account page shows Starter, 15 hours, renewing in a month | |
| 8 | Check the Stripe receipt email for account A | A receipt from Stripe for $9 plus tax, naming Main Course Media LLC | |
| 9 | On the account page, choose Add 5 hours for $5 | Checkout for $5 plus tax. Back on the account page the extra hours show for this month | |
| 10 | Open Manage billing | The Stripe billing portal opens: plan, card, invoices. Close it without changing anything | |
| 11 | Open the panel from a phone at the address the app shows | The panel opens only after signing in as account A, and Record works from there | |
| 12 | Sign out, sign in as account B, choose Redeem a code, enter the friends and family code | No card is asked for. The account page shows the plan at no charge. A second attempt with the same code on account B does nothing new | |
| 13 | Back as account A: Delete my account. Sign in again when asked, type the email, confirm | The page says it is done. In Stripe: the subscription is canceled, a refund for the unused part of the $9 (and its tax) is issued, and the customer is deleted. The $5 top-up is not refunded (the terms say so) | |
| 14 | Sign in again as account A | A new, empty account with no free trial: the page says the trial for this Google account was already used | |
| 15 | Stop the tail (`kill %1`) and run `node scripts/scan-logs.mjs live-run.jsonl` | "No personal data or secrets found", with a few dozen log lines. Then delete `live-run.jsonl` | |

Step 7 ends the trial by hand because the automatic path only fires once
5 hours of audio are used, which a run cannot do honestly. That path
(`endTrialIfSpent`) is covered by `test/trial.test.ts`; what the run proves
is the live charge and the webhook that follows it. The run writes nothing
to the database by hand.

## After

- [ ] Refund account B's plan, if the code charged anything, and cancel it in
      Stripe, or keep it as a real friends and family account.
- [ ] `npm run split`: the run's transcription shows under groq.
- [ ] Every Result cell filled. Anything unexpected goes on the checklist
      before Oct 9.
