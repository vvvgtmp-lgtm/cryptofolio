COMPOSE ?= docker compose

.PHONY: env up down clean ps logs test smoke

env:            ## create .env from the example if missing
	@test -f .env || cp .env.example .env

up: env         ## build and start the whole stack
	$(COMPOSE) up -d --build

down:           ## stop the stack (keep data)
	$(COMPOSE) down

clean:          ## stop the stack and delete all data volumes
	$(COMPOSE) down -v --remove-orphans

ps:
	$(COMPOSE) ps -a

logs:           ## follow logs, e.g. make logs s=api
	$(COMPOSE) logs -f $(s)

test:           ## run every service's lint + unit + integration tests in containers
	./scripts/test.sh

smoke:          ## end-to-end smoke test against the running stack (BASE_URL=http://localhost)
	node scripts/smoke.mjs
