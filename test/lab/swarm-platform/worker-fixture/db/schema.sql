CREATE TABLE jobs (
    id integer PRIMARY KEY,
    duration_ms integer NOT NULL,
    pause_after_effect boolean NOT NULL DEFAULT false,
    state text NOT NULL DEFAULT 'pending',
    owner text,
    attempts integer NOT NULL DEFAULT 0,
    lease_until timestamptz
);
CREATE TABLE effects (
    job_id integer PRIMARY KEY,
    task text NOT NULL,
    attempt integer NOT NULL
);
CREATE TABLE raw_effects (
    id bigint GENERATED ALWAYS AS IDENTITY,
    job_id integer NOT NULL,
    task text NOT NULL,
    attempt integer NOT NULL
);
CREATE TABLE history (
    id bigint GENERATED ALWAYS AS IDENTITY,
    at timestamptz NOT NULL DEFAULT clock_timestamp(),
    kind text NOT NULL,
    task text NOT NULL,
    release text NOT NULL,
    job_id integer,
    attempt integer
);
