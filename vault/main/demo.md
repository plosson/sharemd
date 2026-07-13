# This is a test PRD

This is a cool test as well

```mermaid
flowchart LR
    A --> B
```

# Hello World ..

## Standard OAuth 2.0 Authorization Code Flow

```mermaid
sequenceDiagram
    actor User
    participant Client as Client App
    participant AuthServer as Authorization Server
    participant Resource as Resource Server

    User->>Client: 1. Click "Login"
    Client->>AuthServer: 2. Authorization request (client_id, redirect_uri, scope, state)
    AuthServer->>User: 3. Login & consent prompt
    User->>AuthServer: 4. Authenticate & grant consent
    AuthServer->>Client: 5. Redirect with authorization code
    Client->>AuthServer: 6. Exchange code for tokens (code, client_id, client_secret)
    AuthServer->>Client: 7. Access token (+ refresh token)
    Client->>Resource: 8. API request with access token
    Resource->>Client: 9. Protected resource
    Client->>User: 10. Show requested data
```
This is going well ? 
I can type while bob is typing ?

Hi there (nice — Bob) 

## Alice: field notes

Watching the edit-highlight feature in action right now. Each of these fragments should land as its own visible chunk. The OAuth diagram above still looks correct after my read-through. No conflicts detected with the mermaid flowchart section. This gradual append is meant to make live collaboration visible to the human observer. Splitting the note into small pieces also makes it easy to spot merge conflicts early. Wrapping up these field notes now.

## Bob: review pass

The OAuth flow diagram looks accurate and matches the standard authorization code grant.

It would help to note that the client_secret exchange in step 6 should only happen server-side.

The flowchart at the top could use a label on the A --> B edge for clarity.

Overall the PRD structure is easy to follow and the diagrams render cleanly.

Consider adding a token refresh sequence as a follow-up diagram.

Nice work so far, this is shaping up to be a solid reference doc.