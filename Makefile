.PHONY: bootstrap up down status logs dev worker db-migrate test build check release-check

bootstrap:
	bash scripts/bootstrap.sh

up:
	docker compose --env-file .env -f infra/compose.yml up -d

down:
	docker compose --env-file .env -f infra/compose.yml down

status:
	docker compose --env-file .env -f infra/compose.yml ps

logs:
	docker compose --env-file .env -f infra/compose.yml logs -f

dev:
	bash scripts/dev.sh

worker:
	pnpm worker

db-migrate:
	bash scripts/db-migrate.sh

test:
	pnpm test

build:
	pnpm build

check:
	bash scripts/check.sh

release-check:
	pnpm release:check
