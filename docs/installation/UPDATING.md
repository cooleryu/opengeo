# Updating OpenGEO

Update from [cooleryu/opengeo](https://github.com/cooleryu/opengeo). The public branch is `main`; development branches can contain unfinished work. OpenGEO retains code from Vane, but Vane's published images are not OpenGEO updates.

## Before updating

From your existing OpenGEO checkout, check the repository and branch:

```sh
git remote -v
git branch --show-current
git status --short
```

- Confirm that `origin` points to `cooleryu/opengeo` and that you are updating the intended branch. If the working tree has uncommitted changes, stop here and preserve or finish that work before updating. Do not use `reset --hard` or `clean` to make an update proceed.
- Keep your existing `data/`, `.env`, and `.env.local`. Do not copy the example environment file over an existing configuration. If you use `DATA_DIR` or other custom local paths, retain those paths and their contents too.
- Stop the application before backing up its local data, then keep a copy of that data and your configuration outside the checkout. For Docker, preserve the existing data volume and deployment settings.

## Update the source

If you are already on `main` with a clean working tree:

```sh
git pull --ff-only origin main
```

For a development branch, pull its configured tracking branch with `git pull --ff-only` instead. Do not switch branches or merge `main` just to update. If Git reports divergence or a missing tracking branch, resolve that branch choice before continuing.

Review any configuration changes in [.env.example](../../.env.example) and add only the settings you need to your existing local environment file. Then use the section that matches your deployment.

## Running from source

Use Node.js 24, as described in the [README](../../README.md). Install the dependencies for the updated source:

```sh
npm install
```

For development, restart with:

```sh
npm run dev
```

For an existing production deployment, stop its previous process, rebuild, and restart using the same environment and data paths. To run on the local OpenGEO port:

```sh
npm run build
npm run start -- --hostname 127.0.0.1 --port 4327
```

Open [localhost:4327](http://127.0.0.1:4327) and check that your existing projects and saved records are present. If a process manager runs the application, restart it with its existing configuration instead of starting a second instance.

## Existing Docker Compose deployments

After updating the source, rebuild from this repository using the same Compose project and configuration as before:

```sh
docker compose up -d --build
```

The repository's Compose file builds the local `opengeo:local` image. Its `vane` service name, `vane-data` volume, and `/home/vane/data` mount are retained for compatibility with existing deployments. Keep any environment settings, overrides, and additional mounts you already use; rebuilding does not copy host `.env.local` into the container.

The default Compose port mapping remains `3000:3000`, so check [localhost:3000](http://127.0.0.1:3000), or your existing configured address. Verify that the original projects and saved records are present. Do not remove the data volume or run `docker compose down -v` during an update.

If you originally deployed with `docker run` or a custom Compose file, retain that deployment's volume mapping, environment, and port settings when rebuilding from this repository. Do not replace it with an upstream Vane image. Docker files are retained as a deployment option; this documentation update does not establish that the current OpenGEO workflow has been verified in Docker.
