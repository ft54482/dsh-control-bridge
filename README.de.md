<img src="docs/assets/hero.jpg" alt="DSH Control Bridge — Codex / Grok Bot → DeepSeek Harness" width="100%">

# DSH Control Bridge

[<img src="docs/assets/languages/zh.png" alt="简体中文" height="26">](README.md) [<img src="docs/assets/languages/en.png" alt="English" height="26">](README.en.md) [<img src="docs/assets/languages/fr.png" alt="Français" height="26">](README.fr.md) [<img src="docs/assets/languages/ja.png" alt="日本語" height="26">](README.ja.md) [<img src="docs/assets/languages/ko.png" alt="한국어" height="26">](README.ko.md) [<img src="docs/assets/languages/de.png" alt="Deutsch" height="26">](README.de.md)

Mit Codex, Grok Bot oder einem eigenen Koordinator Aufgaben an einen bestimmten DeepSeek-Harness-Arbeitsbereich übergeben und die Ergebnisse verfolgen. **Sie verwenden Codex und Harness Desktop bereits auf demselben Rechner? Beginnen Sie mit dem Codex-Skill und Desktop Host.** Diese Verbindung nutzt den lokalen Host. Nach der Einrichtung können Sie Harness aus Codex in natürlicher Sprache bedienen.

[Super Agent Cockpit](plugins/dsh-superagent-cockpit/README.md) · [Codex-Skill v0.2.3](https://github.com/ft54482/dsh-control-bridge/releases/tag/skill-v0.2.3) · [ZCode-Skills](skills/zcode/README.md) · [Desktop Host v0.2.2](https://github.com/ft54482/dsh-control-bridge/releases/tag/v0.2.2) · [Dokumentation](docs/README.md) · [Ports und Fehlerbehebung](docs/ports.md) · [Prüfung unter Windows](docs/verified-scope.md)

Die ausführlichen Handbücher sind derzeit überwiegend auf Chinesisch verfasst. Technische Feldnamen und Befehle bleiben in ihrer ursprünglichen Form erhalten.

**Die ZCode-Skills sind fertig (2026-11-25).** Installation und geprüfter Umfang stehen im Schnellstart mit ZCode weiter unten.

## Den passenden Einstieg wählen

| Umgebung und Ziel | Installation oder Aufruf | Erste Prüfung |
| --- | --- | --- |
| Codex Desktop soll bestehende Sitzungen fortsetzen oder für neue Aufgaben eine Hauptsteuerungssitzung öffnen | Den **Skill** in Codex und das **Host-Plugin** im Desktop-Profil von Harness installieren | Mit dem Skill `health` und `granted` ausführen. [Installation und Kopplung](docs/windows-delivery.md#codex-desktop-setup) |
| Mit ZCode eine Desktop-Sitzung fortsetzen, eine Hauptsteuerungssitzung öffnen oder SuperAgent-Tickets versenden | Die beiden **ZCode-Skill**-Verzeichnisse nach `~/.zcode/skills/` kopieren; das Host-Plugin bleibt wie auf dem Codex-Weg | Mit dem Skill `desktop.py health` ausführen, danach seine drei Verhaltenstests. [Schnellstart mit ZCode](skills/zcode/README.md) |
| Ein eigener Bot oder ein Skript braucht mehrere Instanzen, einen Posteingang, Aufgabenfreigaben und Auditdaten | Den **Python-Koordinator** installieren und über die CLI `dsh-bridge` bedienen. Für signierte HTTP-Ereignisse zusätzlich `serve` starten | Mit fake einen Ablauf aus Entwurf, Versand und Ergebnisabgabe durchlaufen. [Koordinator-Handbuch](docs/coordinator.md) |
| Ein vorhandener Werkzeug-Client soll über MCP den Posteingang lesen oder Aufgaben entwerfen | Der Client startet den Unterbefehl `mcp` desselben Python-Koordinators. v0.2.2 verwendet `Content-Length`-Nachrichtenrahmen, die der Client unterstützen muss | Mit einem kompatiblen Client `tools/list` aufrufen. Clients, die nur zeilenweises JSON unterstützen, können zunächst die CLI verwenden. [MCP-Konfiguration und Werkzeuge](docs/coordinator.md) |
| Im Terminal oder in CI soll eine unabhängige Harness-Sitzung laufen | Den Adapter `headless_cli` des Python-Koordinators und ein eigenes Headless-Profil konfigurieren | Die Konfiguration zunächst mit dem Standardwert `spawn = false` prüfen. [Headless CLI](docs/headless-cli.md) |
| Aufgabenplätze und Tickets aller Instanzen sollen in Harness Desktop sichtbar sein | Das optionale **Super Agent Cockpit** installieren und bei mehreren Instanzen den mitgelieferten Aggregator starten | Oben erscheinen Aufgaben aus dem Steuerungsregister und daneben die Zahl aktiver Sitzungen. Die Instanzkarten zeigen die Belegung der Ticket-Ausführer. [Download und Installation](plugins/dsh-superagent-cockpit/README.md) |
| SuperAgent ist eingerichtet und soll Tickets aus Codex erhalten und verfolgen | Mit dem im Skill enthaltenen `github_source.py` Zielinstanz, GitHub-Repository und Absenderkonto prüfen | Mit `precheck` beginnen. Nach dem autorisierten Issue oder Kommentar mit demselben Plan Ticket, Assignment und Worker-Ergebnis verfolgen. [Bedienungsanleitung](skills/deepseek-harness-bridge/references/superagent.md#github-source) |

Die Zuordnung der Verzeichnisse erläutert [Komponenten und Ausführungsorte](docs/README.md#仓库里的几个名字).

## Schnellstart mit Codex Desktop

1. **Skill installieren.** Das eigenständige Skill-ZIP in das persönliche Verzeichnis `~/.agents/skills/` entpacken. Bei einer bestehenden Kopplung lassen sich Host und Berechtigungen weiterverwenden. Für die erste Installation außerdem das kompatible Host-TGZ v0.2.2 sowie das portable Quellcode-ZIP mit Windows-Skripten herunterladen. Ein vorhandener Repository-Checkout ist ebenfalls geeignet. [Skill-ZIP](https://github.com/ft54482/dsh-control-bridge/releases/download/skill-v0.2.3/deepseek-harness-bridge-0.2.3-skill.zip) · [Host, portables Paket und SHA-256](https://github.com/ft54482/dsh-control-bridge/releases/tag/v0.2.2)
2. **Host installieren und koppeln.** Python 3.11+ verwenden. Gemäß Windows-Handbuch den Host im tatsächlich verwendeten Desktop-Profil installieren, eine freie Sitzung im Zielarbeitsbereich auswählen und den Pfad zur Datei mit den dauerhaften Zugangsdaten im Skill hinterlegen. Für das Lesen des Verlaufs `read`, für Aufgabenversand `write` wählen. [Installation und Kopplung](docs/windows-delivery.md#codex-desktop-setup)
3. **Verbindung prüfen.** Codex anweisen: „Prüfe mit `$deepseek-harness-bridge` die lokale Verbindung und liste autorisierte Sitzungen auf.“ Für eine neue Hauptsteuerungssitzung muss im selben Profil die Voreinstellung `master-control` installiert und im Host die Sitzungserstellung aktiviert sein. `health` muss `preset_create_verified=true` zurückgeben. Einen abweichenden Port ebenfalls Codex mitteilen. [Beispiel mit eigenem Port](docs/ports.md#desktop-host)
4. **Sitzung zur Aufgabe auswählen.** Zum Beispiel „Finde die Sitzung zur Exportkorrektur und bearbeite die fehlgeschlagenen Fälle weiter“ oder „Öffne im selben Arbeitsbereich eine neue Hauptsteuerungssitzung für diese unabhängige Aufgabe“. Nach der Erstellung liest der Skill die Voreinstellung aus der tatsächlichen Sitzung zurück, übergibt die Aufgabe und verfolgt den offiziellen Endzustand anhand der Anfrage-ID. [Sitzungsbefehle und Prüffelder](skills/deepseek-harness-bridge/references/desktop.md#new-work-in-master-control-mode)

## Schnellstart mit ZCode

**Stand: fertig (2026-11-25).** Der Versand von SuperAgent-Tickets wurde auf einem Windows-Rechner mit zwei Instanzen geprüft: ein erstes Ticket und eine Fortsetzung auf demselben Ticket endeten beide mit `completed`, das Repository blieb unverändert. Noch nicht geprüft sind der Versand über ein neues Issue und der echte Versand einer Aufgabe aus ZCode an eine Desktop-Hauptsteuerungssitzung. Die vollständige Liste steht unter [Prüfung unter Windows](docs/verified-scope.md).

1. **Voraussetzungen.** Python 3.11 oder neuer. Das Host-Plugin ist in Harness Desktop installiert und gekoppelt, genau wie auf dem Codex-Weg. Für SuperAgent-Tickets brauchen Sie außerdem einen eingerichteten SuperAgent und eine angemeldete GitHub-CLI.
2. **Versand-Skill installieren.** `skills/zcode/deepseek-harness-bridge/` nach `~/.zcode/skills/` kopieren, die enthaltene `connection.example.json` als `connection.json` kopieren und Pfade, Ports und SuperAgent-Instanzen des eigenen Rechners eintragen. Die Datei enthält nur Pfade und Ports; der Zugang bleibt beim Host.
3. **Koordinator-Skill installieren (optional).** Dieses Repository außerhalb aller Skill-Verzeichnisse klonen, `skills/zcode/dsh-control-bridge/` nach `~/.zcode/skills/` kopieren und `local.example.json` als `local.json` mit dem Pfad des Klons kopieren.
4. **Prüfen und loslegen.** Eine neue ZCode-Sitzung öffnen. `python ~/.zcode/skills/deepseek-harness-bridge/scripts/desktop.py health` ausführen, danach die drei Verhaltenstests im Verzeichnis `tests/` des Skills; alle müssen bestehen. Danach können Sie ZCode bitten, „diese Aufgabe an SuperAgent zu schicken“ oder „die Sitzung zu finden, die das zuletzt erledigt hat, und fortzusetzen“.

Die ZCode-Skills teilen die Upstream-Clients mit dem Codex-Skill und bringen vier Helper-Skripte mit: Eines bereitet ein SuperAgent-Ticket aus einer Auftragsdatei vor und ermittelt den Port der Instanz anhand des Repositorys, eines wartet, bis ein Ticket endet, eines schickt eine Auftragsdatei an eine Desktop-Sitzung und eines fasst die Sitzungsliste in einer Tabelle zusammen. [ZCode-Skills](skills/zcode/README.md)

## Eigene Ports verwenden

| Zielservice | Standardverbindung | Einstellungen auf beiden Seiten |
| --- | --- | --- |
| Harness Desktop Host | `127.0.0.1:8765` | `port` in der Host-Plugin-Konfiguration, `--url` bei der Kopplung und `--port` bei jedem Skill-Aufruf |
| Eingang für signierte Ereignisse des Python-Koordinators | `127.0.0.1:8787` | Mit `serve --port` starten und die URL `/v1/events` beim Absender anpassen |
| SuperAgent-Verwaltungsservice | Der Helper verwendet standardmäßig `127.0.0.1:3082` | Den tatsächlich verwendeten Port des Zielprofils ermitteln und an `superagent.py --port PORT state` übergeben |
| MCP des Koordinators | Standardeingabe und Standardausgabe eines lokalen Unterprozesses | Startbefehl, Konfigurationsdatei und Datenverzeichnis festlegen. Ein TCP-Port wird nicht benötigt |

Richten Sie die Dienste ein, die Ihr gewählter Einstieg verwendet. Die Ports `:9` und `:10` der fake-Beispiele sind Platzhalter. Das vollständige Handbuch zeigt die Kopplung über eigene Ports sowie die Diagnose bei falschem Zielservice, fehlerhaften Zugangsdaten oder fehlender Arbeitsbereichsberechtigung. [Ports und Fehlerbehebung](docs/ports.md)

## Schnellstart mit dem Python-Koordinator

Diese Befehle im Stammverzeichnis des Repositorys mit Python 3.11+ ausführen. Das fake-Beispiel simuliert den vollständigen Ablauf lokal und benötigt weder Harness-Zugangsdaten noch Modellguthaben.

```sh
python -m pip install -e .
python examples/e2e_fake.py
dsh-bridge --config examples/config.example.toml check
```

Im Beispiel besitzen `local-desktop` und `lab-server` absichtlich jeweils einen Arbeitsbereich namens `broadcast-cs`. Das Ziel wird anhand von Instanz und Arbeitsbereich gemeinsam bestimmt. Die Aufgaben unterscheiden gewöhnliche Sitzungen `ordinary_session` und länger laufende Aufgaben `superagent`. Der Standardmodus ist `draft`; der Versand erfordert ein vom Bediener bereitgestelltes `mandate`. Die von fake erzeugten Ticket-/Run-Kennungen dienen der Demonstration. Reale Assignment-Datensätze verfolgen Sie über die zugehörige SuperAgent-Verwaltung. [Befehle und Freigaben](docs/coordinator.md) · [Adapter-Funktionen](docs/adapters.md)

[Entwicklung und Beiträge](CONTRIBUTING.md) · [Sicherheit](SECURITY.md) · [MIT-Lizenz](LICENSE)
