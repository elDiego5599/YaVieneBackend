.PHONY: dev build start test

# Levanta el backend con local.env cargado (como lo hace start-test.sh).
# Requiere: npm install y local.env con JWT_SECRET, ADMIN_API_KEY, DEMO_MODE.
dev:
	set -a && source local.env && set +a && npm run dev

build:
	npm run build

start:
	set -a && source local.env && set +a && node dist/index.js

test:
	npm test

# Docker (opcional): levanta con hot-reload dentro de contenedor.
docker-dev:
	docker compose up --build

docker-down:
	docker compose down
