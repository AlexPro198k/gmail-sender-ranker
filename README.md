# Gmail Sender Ranker

A Chrome Manifest V3 extension that ranks sender labels shown in Gmail's Inbox.
It counts each displayed conversation once, scans all Inbox pages, and provides
the complete ranking in the extension popup with a CSV download option.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked** and choose this project folder.
4. Open or refresh Gmail, then select the Gmail Sender Ranker extension.
5. Select **Scan Inbox** and leave Gmail open until the scan completes.

The ranking scan only runs on `https://mail.google.com/`, reads sender labels
visible in Gmail's Inbox list, and restores the Gmail view that was open.

## One-click rules and API scan

Users click **Sign in with Google** in the popup and approve Gmail access in Google's
standard consent screen. No setup is needed on the user's side.

Each row with a single email address has two buttons (a confirmation is shown first):

- **Delete Always**: creates a Gmail filter that sends the sender's future mail to
  Trash, and moves all their existing mail to Trash.
- **Block**: creates a filter that skips the Inbox, marks mail as read and applies
  a `Blocked` label, and moves all their existing mail to Trash.

Trashed mail is recoverable for 30 days. Your own address is refused.

### Developer setup (once, by whoever distributes the extension)

The extension has a fixed ID (`lkfilmimapchcgggaklhakadannjfhbi`, from the `key` in
`manifest.json`), so this only has to be done once:

1. In [Google Cloud Console](https://console.cloud.google.com/) create a project and
   enable the **Gmail API**.
2. **OAuth consent screen**: user type External, add the scopes
   `.../auth/gmail.modify` and `.../auth/gmail.settings.basic`. While in Testing mode
   add each user as a **test user**; to remove the "unverified app" warning for the
   public, submit the app for Google verification.
3. **Credentials > Create credentials > OAuth client ID**, type **Web application**,
   with **Authorized redirect URI** `https://lkfilmimapchcgggaklhakadannjfhbi.chromiumapp.org/`.
4. Put the client ID in `config.js` (`CLIENT_ID`) and reload the extension.

If you publish to the Chrome Web Store, the store assigns a different extension ID;
update the redirect URI to match.

Run `node tests/gmail-rules.test.mjs` and `node tests/gmail-scan.test.mjs` to test the API logic.

## Notes

- Results are conversation counts, not individual email counts within threads.
- Gmail's displayed sender labels may be abbreviated and can represent multiple
  participants in a conversation.
- The scan stops with an error if Gmail's page layout changes or pagination does
  not advance, rather than presenting a partial result as complete.

## Outlook / Hotmail / Live (mobile web app)

The mobile page can also manage Microsoft mailboxes through Microsoft Graph, with the same features
(rank senders, preview subjects and full message content, Delete / Folder / Delete Always / Block, Empty Trash, Delete Spam, Delete Inbox by age).
For Gmail, Auto Rule Suggestions group business senders by brand domain and apply a domain-wide rule;
public mailbox providers remain scoped to each sender address and use the mailbox name as the folder suggestion.

1. In the [Entra admin center](https://entra.microsoft.com/) go to **App registrations > New registration**.
   Choose **Accounts in any organizational directory and personal Microsoft accounts**.
2. Under **Authentication > Add a platform > Single-page application**, add the mobile page URL
   (for example `https://alexpro198k.github.io/gmail-sender-ranker/mobile/index.html`) as a redirect URI.
3. Under **API permissions** add delegated Microsoft Graph `Mail.ReadWrite`, `MailboxSettings.ReadWrite` and `User.Read`.
4. Put the Application (client) ID in `config.js` as `MS_CLIENT_ID`. The Microsoft sign-in button stays hidden until it is set.

Rules are created as Outlook inbox rules named `Sender Ranker: <action> <email>`.
"Delete Always" and "Block" map to a delete rule and a move-to-"Blocked"-folder rule.
