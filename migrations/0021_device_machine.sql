-- The same Mac signing in again replaces its earlier entry.
--
-- Until now every completed sign-in added a device, so a Mac that lost its
-- account.json (its data folder removed, or the app reinstalled onto a clean
-- home) and signed in again showed up twice on the account page, the old
-- entry "Not connected" until its token idled out after 90 days.
--
-- The app now sends an opaque machine id with /device/start: a SHA-256 the
-- app derives on the Mac, never shown to a browser. The pending claim keeps
-- only a hash of it (machine_hash, gone with the claim within ten minutes),
-- and the device keeps machine_key, a hash of that hash bound to the account
-- and the profile. A key therefore means nothing outside the one account it
-- was made for: two accounts signed in on the same Mac hold unrelated keys,
-- and no stored value can be matched against another account's.
--
-- When a token is collected, any other live device of the same account with
-- the same key is revoked (src/devices.ts). Devices from before this, and
-- apps that send no id, have no key and are never matched.

ALTER TABLE device_codes ADD COLUMN machine_hash TEXT;
ALTER TABLE devices ADD COLUMN machine_key TEXT;
CREATE INDEX devices_by_machine ON devices(account_id, machine_key);
