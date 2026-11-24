<img src="docs/assets/hero.jpg" alt="DSH Control Bridge — Codex / Grok Bot → DeepSeek Harness" width="100%">

# DSH Control Bridge

[<img src="docs/assets/languages/zh.png" alt="简体中文" height="26">](README.md) [<img src="docs/assets/languages/en.png" alt="English" height="26">](README.en.md) [<img src="docs/assets/languages/fr.png" alt="Français" height="26">](README.fr.md) [<img src="docs/assets/languages/ja.png" alt="日本語" height="26">](README.ja.md) [<img src="docs/assets/languages/ko.png" alt="한국어" height="26">](README.ko.md) [<img src="docs/assets/languages/de.png" alt="Deutsch" height="26">](README.de.md)

Permettez à Codex, Grok Bot ou votre propre coordinateur de confier des tâches à un espace de travail DeepSeek Harness précis et d'en suivre les résultats. **Vous utilisez déjà Codex et Harness Desktop sur le même ordinateur ? Commencez par le skill Codex et Desktop Host.** Cette connexion passe par le Host local et permet ensuite de piloter Harness en langage naturel depuis Codex.

[Tableau de bord Super Agent](plugins/dsh-superagent-cockpit/README.md) · [Skill Codex v0.2.3](https://github.com/ft54482/dsh-control-bridge/releases/tag/skill-v0.2.3) · [Desktop Host v0.2.2](https://github.com/ft54482/dsh-control-bridge/releases/tag/v0.2.2) · [Documentation](docs/README.md) · [Ports et dépannage](docs/ports.md) · [Validation sur Windows](docs/verified-scope.md)

Les guides détaillés sont actuellement rédigés principalement en chinois. Les noms de champs et les commandes techniques sont conservés dans leur forme originale.

## Choisir un point d'entrée

| Votre environnement et votre objectif | Installation ou commande | Première vérification |
| --- | --- | --- |
| Codex Desktop, pour reprendre une session ou ouvrir une session de pilotage pour une nouvelle tâche | Installez le **skill** dans Codex et le **plugin Host** dans le profil desktop de Harness | Exécutez `health` et `granted` avec le skill. [Installation et appairage](docs/windows-delivery.md#codex-desktop-setup) |
| Votre bot ou script doit gérer plusieurs instances, une boîte de réception, les approbations et l'audit | Installez le **coordinateur Python** et utilisez la CLI `dsh-bridge`. Lancez `serve` pour recevoir des événements HTTP signés | Exécutez d'abord un cycle de préparation, d'envoi et de remise avec fake. [Guide du coordinateur](docs/coordinator.md) |
| Un client d'outils doit lire la boîte de réception ou préparer des tâches via MCP | Faites lancer au client la sous-commande `mcp` du même coordinateur Python. La version v0.2.2 utilise des trames `Content-Length`, que le client doit prendre en charge | Appelez `tools/list` avec un client compatible. Un client qui accepte uniquement du JSON ligne par ligne peut utiliser la CLI. [Configuration et outils MCP](docs/coordinator.md) |
| Le terminal ou la CI doit exécuter une session Harness indépendante | Configurez l'adaptateur `headless_cli` du coordinateur Python et un profil headless distinct | Vérifiez d'abord la configuration avec la valeur par défaut `spawn = false`. [Headless CLI](docs/headless-cli.md) |
| Vous souhaitez voir les emplacements de tâches et les tickets de chaque instance dans Harness Desktop | Installez le **tableau de bord Super Agent** facultatif et lancez l'agrégateur fourni pour plusieurs instances | Les tâches du registre de pilotage s'affichent en haut, à côté du nombre de sessions actives. Chaque carte indique l'occupation des exécuteurs de tickets. [Téléchargement et installation](plugins/dsh-superagent-cockpit/README.md) |
| SuperAgent est déployé et vous souhaitez envoyer et suivre des tickets depuis Codex | Utilisez le `github_source.py` fourni avec le skill pour vérifier l'instance cible, le dépôt GitHub et le compte expéditeur | Commencez par `precheck`. Après l'envoi d'une issue ou d'un commentaire autorisé, utilisez le même plan pour suivre Ticket, Assignment et le résultat du worker. [Guide d'utilisation](skills/deepseek-harness-bridge/references/superagent.md#github-source) |

Consultez [les composants et leur emplacement d'exécution](docs/README.md#仓库里的几个名字) pour comprendre les répertoires du dépôt.

## Démarrage rapide avec Codex Desktop

1. **Installez le skill.** Extrayez le ZIP du skill dans votre répertoire personnel `~/.agents/skills/`. Si l'appairage existe déjà, vous pouvez réutiliser le Host et les autorisations. Pour une première installation, téléchargez aussi le TGZ Host v0.2.2 compatible et le ZIP source portable contenant les scripts Windows, ou utilisez une copie du dépôt. [ZIP du skill](https://github.com/ft54482/dsh-control-bridge/releases/download/skill-v0.2.3/deepseek-harness-bridge-0.2.3-skill.zip) · [Host, archive portable et SHA-256](https://github.com/ft54482/dsh-control-bridge/releases/tag/v0.2.2)
2. **Installez et appairez le Host.** Utilisez Python 3.11+. Suivez le guide Windows pour installer le Host dans le profil desktop utilisé, choisissez une session inactive dans l'espace de travail cible et indiquez au skill le chemin du fichier d'identifiants persistants. Choisissez `read` pour consulter l'historique ou `write` pour envoyer des tâches. [Installation et appairage](docs/windows-delivery.md#codex-desktop-setup)
3. **Vérifiez la connexion.** Demandez à Codex « Utilise `$deepseek-harness-bridge` pour vérifier la connexion locale et lister les sessions autorisées ». Pour créer une session de pilotage, vérifiez aussi que le même profil contient le préréglage `master-control`, que la création de sessions est activée dans le Host et que `health` renvoie `preset_create_verified=true`. Indiquez également votre port personnalisé à Codex. [Exemple avec un autre port](docs/ports.md#desktop-host)
4. **Choisissez la session selon la tâche.** Demandez « Retrouve la session de correction de l'export et poursuis les cas en échec » ou « Ouvre une nouvelle session de pilotage dans le même espace de travail pour cette tâche indépendante ». Après la création, le skill relit le préréglage dans la session réelle, envoie la tâche et suit l'état final officiel par l'identifiant de requête. [Commandes et champs de validation](skills/deepseek-harness-bridge/references/desktop.md#new-work-in-master-control-mode)

## Utiliser d'autres ports

| Service à joindre | Connexion par défaut | Réglages des deux côtés |
| --- | --- | --- |
| Harness Desktop Host | `127.0.0.1:8765` | `port` dans la configuration du plugin Host, `--url` lors de l'appairage et `--port` à chaque appel du skill |
| Récepteur d'événements signés du coordinateur Python | `127.0.0.1:8787` | Lancez `serve --port` et mettez à jour l'URL `/v1/events` de l'expéditeur |
| Service de gestion SuperAgent | Le helper utilise `127.0.0.1:3082` par défaut | Relevez le port réellement écouté par le profil cible et utilisez `superagent.py --port PORT state` |
| MCP du coordinateur | Entrée et sortie standard d'un sous-processus local | Configurez la commande de lancement, le fichier de configuration et le répertoire de données. Aucun port TCP à attribuer |

Configurez les services nécessaires au point d'entrée choisi. Les ports `:9` et `:10` des exemples fake sont des valeurs fictives. Le guide complet montre l'appairage sur un autre port et aide à identifier un mauvais service, des identifiants incorrects ou un espace de travail non autorisé. [Ports et dépannage](docs/ports.md)

## Démarrage rapide du coordinateur Python

Depuis la racine du dépôt, exécutez ces commandes avec Python 3.11+. L'exemple fake simule tout le processus localement, sans identifiants Harness ni crédit de modèle.

```sh
python -m pip install -e .
python examples/e2e_fake.py
dsh-bridge --config examples/config.example.toml check
```

L'exemple donne volontairement à `local-desktop` et à `lab-server` un espace de travail nommé `broadcast-cs`. Identifiez la cible par l'instance et l'espace de travail ensemble. Les tâches distinguent les sessions ordinaires `ordinary_session` des tâches longues `superagent`. Le mode par défaut est `draft` ; l'envoi exige un `mandate` fourni par l'opérateur. Les identifiants ticket/run créés par fake servent à la démonstration. Suivez les Assignment réels dans l'interface de gestion SuperAgent correspondante. [Commandes et approbations](docs/coordinator.md) · [Capacités des adaptateurs](docs/adapters.md)

[Développement et contributions](CONTRIBUTING.md) · [Sécurité](SECURITY.md) · [Licence MIT](LICENSE)
