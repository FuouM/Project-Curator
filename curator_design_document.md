## Project Curator: Technical Design Document

*   **Version:** 4.0
*   **Date:** August 8, 2025

### 1. Vision & Guiding Principles

Project Curator is a local-first backend system designed to organize and search a large collection of digital images.

*   **Local-First & Private:** All user data, metadata, and AI models reside on the user's machine. Privacy is paramount.
*   **Non-Destructive:** The system will **never** modify, move, or rename the original source image files.
*   **Secure by Design:** The system is engineered with a strict, sandboxed architecture and a "default-deny" permissions model to protect the user from malicious or faulty extensions.
*   **Full Auditability & Reversibility:** Every change is tracked. The system supports soft deletes and transactional rollbacks, ensuring no data is ever truly lost and actions can be undone.
*   **Robust & Consistent:** The architecture guarantees data consistency between its different storage systems through formal transactional patterns and reconciliation tools.
*   **Adaptable & Future-Proof:** The data model and architecture are designed to accommodate new AI models and user-specific concepts over time.

### 2. Core Architecture: The Single-Writer Service Model

The system operates on a strict **Single-Writer Principle**: the Curator Service is the only component that can write to the Metadata Store. All other components (Dashboard, CLI, Plugins) are clients that interact with the system via a formal, secure Service API.

1.  **The Curator Service:** A persistent background service that manages the task queue, handles all file processing, and hosts the Service API.
2.  **The Service API (IPC/HTTP):** The formal, secure, and versioned API for all system operations.
3.  **The Curator Dashboard (GUI Client):** The primary UI for user interaction, acting as a client to the Service API.
4.  **The Headless CLI (Command-Line Client):** A scriptable client for automation, also using the Service API.
5.  **The Metadata Store:** The SQL and Vector databases, exclusively managed by the Curator Service.
6.  **The Plugin System:** A secure, sandboxed environment for extending functionality, with plugins interacting via the Service API.

### 3. The Service API Contract

The API is the single source of truth for all operations.

#### 3.1. API Specification & Transport

*   **Contract:** The API is formally defined in an **OpenAPI v3.1** specification.
*   **Transport:** The service will listen on a local-only transport by default, **never binding to 0.0.0.0**.
    *   **Linux/macOS:** Unix Domain Socket (`/run/curator.sock`).
    *   **Windows:** Named Pipe or loopback HTTP with TLS and a client token.
*   **Versioning:** The API will be versioned via the URL path (e.g., `/v1/...`). The `X-Curator-API-Version` header will be included in all responses.

#### 3.2. Authentication & Authorization

*   **Service Key:** On first install, a master Service Key is generated and stored securely in the OS keychain (Windows Credential Manager, macOS Keychain, Linux Keyring).
*   **Client Tokens:** Clients (Dashboard, CLI) authenticate with the service via local IPC to request short-lived, ephemeral JWT tokens. This prevents malicious processes from easily calling the API.

#### 3.3. Error Handling & Idempotency

*   **Error Codes:** Uses standard HTTP status codes (e.g., `400` Bad Request, `401` Unauthorized, `409` Conflict, `503` Service Unavailable).
*   **Retries:** 5xx server errors should be retried by the client with exponential backoff.
*   **Idempotency:** For critical write operations, clients can provide an `Idempotency-Key: <UUID>` header to ensure the operation is only performed once, even if retried.

### 4. The Metadata Store & Data Model

#### 4.1. Database Consistency Strategy

A hybrid **"Eventual + Idempotent"** strategy is used to guarantee consistency between the SQL and Vector databases.
1.  A write operation (e.g., adding an image) first commits to the primary SQL database. The vector processing is enqueued as a background job with a `pending` status.
2.  A background worker processes the job, generates the vector, and writes it to the vector DB.
3.  Upon successful vector write, the worker updates the SQL row's status to `ready`.
4.  A periodic **Reconciliation Job** runs to find and fix inconsistencies (e.g., records stuck in `pending`, or dangling vectors). A `curator-admin repair vectors` command will be available to trigger this manually.

#### 4.2. Final SQL Schema

```sql
-- Tracks all known sources of data (user, plugins, ai models, etc.)
CREATE TABLE sources (
    id BIGSERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL, -- "user", "plugin:acme_tagger_v1.2", "ai:clip-vit-L-14"
    type TEXT NOT NULL,        -- "USER", "PLUGIN", "AI_MODEL"
    manifest JSONB,
    installed_at TIMESTAMP
);

CREATE TABLE images (
    id BIGSERIAL PRIMARY KEY,
    sha256 TEXT UNIQUE NOT NULL,
    phash TEXT,
    current_filepath TEXT NOT NULL,
    os_file_id TEXT,
    mtime BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL -- For soft deletes
);

CREATE TABLE tags (
    id BIGSERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL
);

-- Allows full audit and rollback of tag changes.
CREATE TABLE image_tags (
    id BIGSERIAL PRIMARY KEY,
    image_id BIGINT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    tag_id BIGINT NOT NULL REFERENCES tags(id),
    source_id BIGINT NOT NULL REFERENCES sources(id),
    confidence REAL,
    transaction_id UUID NULL, -- Groups related changes for undo
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    UNIQUE (image_id, tag_id, source_id, transaction_id) -- Ensures idempotency within a transaction
);

CREATE TABLE image_vectors (
    id BIGSERIAL PRIMARY KEY,
    image_id BIGINT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    source_id BIGINT NOT NULL REFERENCES sources(id), -- Points to the AI model in the sources table
    vector_id TEXT NOT NULL,      -- ID in the external vector DB
    vector_checksum TEXT,
    vector_state TEXT NOT NULL DEFAULT 'pending', -- "pending", "ready", "failed"
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (image_id, source_id)
);

CREATE TABLE tag_aliases (
    alias TEXT PRIMARY KEY,
    canonical_tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE tag_hierarchy (
    parent_tag_id BIGINT NOT NULL REFERENCES tags(id),
    child_tag_id BIGINT NOT NULL REFERENCES tags(id),
    PRIMARY KEY (parent_tag_id, child_tag_id)
);
```
**Required Indexes:** Composite indexes will be created on foreign keys, `(tag_id, is_deleted)` for fast tag-based queries, `sha256`, and FTS5 indexes for text search.

### 5. Plugin System & Security Sandbox

#### 5.1. Runtime Environment

*   **Default Runtime:** Plugins will execute in a **WASM (WebAssembly) runtime with WASI** (WebAssembly System Interface). This provides strong, cross-platform sandboxing with deterministic resource limits.
*   **Alternative Runtime:** For trusted, high-performance plugins requiring native binaries, an external process sandbox will be used (e.g., via Linux `seccomp`+`cgroups`, Windows Job Objects). This is an advanced feature requiring explicit user approval.

#### 5.2. Permissions, Manifest & Signing

*   **Permissions Model:** Plugins operate under a **default-deny**, least-privilege model. All capabilities (e.g., `tags:write`, `network:fetch`) must be declared in the manifest.
*   **Manifest:** Every plugin must include a `manifest.json` file specifying its name, version, runtime, entrypoint, and required permissions.
    ```json
    {
      "name": "AcmeTagger", "version": "1.0.0", "runtime": "wasi",
      "entrypoint": "tagger.wasm",
      "permissions": { "tags:write": true, "network:fetch": "api.acme.com" },
      "signature": "..."
    }
    ```
*   **Signing & Governance:** Plugins for any official marketplace must be signed by a Curator-controlled CA. Users can install unsigned local plugins but will receive a strong security warning.

### 6. Backup, Restore & Disaster Recovery

#### 6.1. Backup Format

A backup is a versioned, compressed archive containing a signed JSON manifest.
*   **Manifest:** Includes Curator version, timestamps, checksums for all files, and encryption parameters.
*   **Contents:** The archive contains the SQL database dump, a snapshot of the vector DB, and the manifest file with its signature.

#### 6.2. Encryption

*   **Algorithm:** Backups can be encrypted using **AES-256-GCM**.
*   **Key Derivation:** The encryption key is derived from a user-provided passphrase using **Argon2id** to prevent brute-force attacks. The Argon2id parameters are stored in the manifest.

#### 6.3. Verification & Restore

*   **Verification:** A `curator-admin backup verify` command will perform a dry-run restore into a temporary location and run sanity checks to ensure integrity.
*   **Restore:** The restore process validates checksums and signatures before overwriting any data. It will flag if AI model versions have changed since the backup was made, suggesting a re-indexing.

### 7. Detailed Workflows

#### 7.1. Search Architecture

1.  The query DSL (`tag:foo -bar text:"hello" concept:sunset^0.8`) is parsed into an Abstract Syntax Tree (AST).
2.  Tag aliases and hierarchies are resolved.
3.  Vector searches (for concepts/semantic text) are executed against the vector DB, returning a candidate set of `image_id`s with scores.
4.  SQL queries (for tags/filters) are executed against the SQL DB.
5.  The results are merged in the application layer, where a final ranking score is computed based on a weighted combination of semantic and metadata scores.
6.  Each result can include an `explain` field detailing which terms and scores contributed to its rank.

#### 7.2. Concept Training Pipeline

1.  **Selection:** User selects positive (>=10) and negative (>=50) examples.
2.  **Model Training:** The service computes embeddings for all examples and trains two candidate models in parallel:
    *   **Fast:** A centroid vector of the positive examples.
    *   **Accurate:** A calibrated logistic regression classifier.
3.  **Evaluation:** The service uses cross-validation to compute precision/recall metrics for both models and presents them to the user.
4.  **Review & Calibration:** The user is shown a **Review Queue** of the highest-confidence matches. A slider allows them to adjust the precision/recall tradeoff, with the UI showing the immediate impact on the candidate set.
5.  **Application:** Once the user approves, the tags are applied with a unique `transaction_id`, allowing the entire operation to be undone with a single click.

### 8. Observability & Health Monitoring

*   **Metrics:** The service will expose key operational metrics in a Prometheus-compatible format (e.g., `curator_task_queue_backlog`, `curator_search_latency_seconds`).
*   **Logging:** All logs will be structured (JSON format) and include a `transaction_id` to correlate events across the system.
*   **Diagnostics:** The `curator-admin diagnostic-bundle` command will package sanitized logs, metrics, and database metadata for support requests.

### 9. Packaging & Release Management

*   **Packaging:**
    *   **Windows:** Signed MSI installer and a portable ZIP. Updates via MSIX or Squirrel.
    *   **macOS:** Signed and notarized .DMG package.
    *   **Linux:** AppImage and Flatpak for broad compatibility.
*   **Updates:** All automatic updates must be cryptographically signed. The client will verify the signature before applying the update.

### 10. Prioritized Implementation Roadmap

#### Milestone 1: MVP (Core Engine & Safety)
1.  **Service & API:** Implement the core Curator Service with the single-writer principle and a minimal OpenAPI spec.
2.  **Database:** Implement the full SQL schema with Alembic for migrations.
3.  **Consistency:** Implement the vector generation pipeline with the `vector_state` column and a manual reconciliation command.
4.  **UI/CLI:** Build a basic Dashboard and CLI capable of adding/searching images and tags via the API.
5.  **Security:** Implement plugin manifest parsing and validation, but keep runtime disabled.

#### Milestone 2: Production Readiness (v1.0)
1.  **Concept Training:** Implement the full human-in-the-loop concept training pipeline.
2.  **Plugin Sandbox:** Fully implement the WASM runtime with resource limits and the permissions model.
3.  **Backup/Restore:** Implement the full encrypted, verified backup and restore system.
4.  **Observability:** Integrate metrics and structured logging.

#### Milestone 3: Scale & Polish (v2.0)
1.  **Database Scaling:** Add official support for PostgreSQL and a production-grade vector DB (e.g., Qdrant).
2.  **Search:** Implement the full DSL with advanced features like tag hierarchy resolution.
3.  **Packaging:** Finalize platform-native installers with signed auto-updates.
4.  **Marketplace:** Develop the infrastructure for a secure, signed plugin marketplace.