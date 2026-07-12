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
```# This is a test PRD

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