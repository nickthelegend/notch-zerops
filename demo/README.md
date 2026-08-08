# demo/ — an example app, not part of Brain

This directory is a **fixture**. Nothing here is built, imported, or run by Brain; it exists so
the drift scanner has a realistic multi-service application to read.

It describes a plausible SaaS backend — an API that uses Postgres for records, Valkey for
sessions, Meilisearch for search, Qdrant for embeddings, NATS for background jobs, and object
storage for uploads — and it holds the app secrets you would expect alongside them.

Point Brain at this directory and every service it reports is genuinely asked for by a file in
here: a client library in `package.json`, or a connection variable in `.env.example`. Each
finding cites the line that produced it, and the ones inferred from an env-var name are marked
low-confidence, because a name is weaker evidence than an import.

Brain's own repository is deliberately *not* a good demo — it needs two services. That is the
honest answer for what it is, and dressing it up with dependencies the code does not use would
make the tool wrong about the one repository a judge can check.
