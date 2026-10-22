# OAuth clients for Open Coding Partner

Open Coding Partner ships no Google or Microsoft OAuth client. You create a client in your own Google Cloud or Azure account, then paste the client id and client secret into Accounts. The client secret and refresh token stay in the local credentials vault. They are not written into the task log.

The redirect URL is loopback, on the same machine as the app:

`http://127.0.0.1:<port>/api/accounts/google/callback`

`http://127.0.0.1:<port>/api/accounts/microsoft/callback`

`<port>` is the port the app is bound to. The default is `4317`.

OCP uses PKCE (`S256`) and shows the scopes below before it opens the consent page.

## Google

1. Open Google Cloud Console and create or choose a project you control.
2. Configure the OAuth consent screen. Add yourself as a test user if the app is in testing.
3. Create an OAuth client of type **Desktop** or **Web**, and add the loopback redirect URL above.
4. Copy the client id and client secret into OCP Accounts. OCP does not have a client of its own to copy.
5. Review the scopes, then choose **Connect Google with these scopes**.

Scopes OCP requests:

- `openid` and `email`, so the connected address can be shown
- `https://www.googleapis.com/auth/gmail.readonly` for Gmail read and search
- `https://www.googleapis.com/auth/gmail.compose` for Gmail drafts. OCP does not call send
- `https://www.googleapis.com/auth/calendar.readonly` for Calendar read
- `https://www.googleapis.com/auth/calendar.events` for Calendar create, which still asks for approval
- `https://www.googleapis.com/auth/drive.readonly` for Drive search and read

OCP does not request Gmail send, Gmail modify, or full Drive access.

## Microsoft

1. Open Microsoft Entra and register an application you control.
2. Under Authentication, add the Microsoft loopback redirect URL as a **Mobile and desktop** or **Web** redirect.
3. Create a client secret. Paste the application (client) id and the secret into OCP Accounts.
4. Review the scopes, then choose **Connect Microsoft with these scopes**.

Scopes OCP requests:

- `offline_access`, so a refresh token can be stored in the vault
- `User.Read` for the signed-in address
- `Mail.Read` for Outlook read and search
- `Mail.ReadWrite` for Outlook drafts. OCP does not call send
- `Calendars.Read` for Outlook calendar read
- `Calendars.ReadWrite` for Outlook calendar create, which still asks for approval
- `Files.Read` for OneDrive search and read

OCP does not request `Mail.Send` or `Files.ReadWrite`.

## After consent

A refresh token is encrypted in the vault. Disconnect removes that refresh token. The client secret remains until you delete that vault item. Signing in on the virtual computer is separate: Take Control and type on that screen yourself.
