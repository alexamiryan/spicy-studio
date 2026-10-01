-- Elements sent to providers as their own "elements" / subjects (Kling O3 on SpicyAPI, Higgsfield Elements).

-- One line on who or what the element is (providers ask for it).
alter table elements add column description text not null default '';

-- Public URL of an uploaded reference, for providers whose element APIs need one besides the media id.
alter table provider_uploads add column url text;

-- Elements created in a provider account (Higgsfield), reused until the element's photos or text change.
create table provider_elements (
  user_id uuid not null references users on delete cascade,
  provider_id text not null,
  element_id uuid not null references elements on delete cascade,
  signature text not null,
  remote_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, provider_id, element_id)
);
