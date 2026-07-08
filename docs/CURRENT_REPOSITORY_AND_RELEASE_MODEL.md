# Aktualny model repozytoriow i releasu

Ten dokument opisuje **obecny, przyjety model** dla JustyBase po rozdzieleniu developmentu od publicznej fasady informacyjnej.

To nie jest juz plan migracji publishera. Publisher Visual Studio Marketplace zostaje bez zmian, a publiczne linki projektu wskazuja na neutralna fasade organizacyjna.

## 1. Stan docelowy

1. Marketplace publisher zostaje:
   - `krzysztof-d`
2. Core extension ID zostaje:
   - `krzysztof-d.justybaselite-netezza`
3. Optional extensions dalej zaleza od core extension ID:
   - `krzysztof-d.justybaselite-netezza`
4. Publiczne repo informacyjne:
   - `https://github.com/justybase/justybase-vscode`
5. Prywatne repo development/release:
   - `justybase-vscode-private`
6. Author/copyright w metadanych projektu:
   - `JustyBase Maintainers`

Konsekwencja: Marketplace nadal publicznie pokazuje `krzysztof-d.justybaselite-netezza`. Ten model zachowuje automatyczne aktualizacje dla obecnych uzytkownikow i neutralizuje biezace linki/repo/maintenance, ale nie ukrywa historycznego publishera.

## 2. Publiczna fasada

Publiczna fasada jest repo informacyjnym, bez kodu zrodlowego rozszerzenia.

Powinna zawierac:

1. `README.md` z opisem produktu.
2. Link do Marketplace.
3. `PRIVACY.md`.
4. `SECURITY.md`.
5. `CHANGELOG.md` albo podstawowe release notes.
6. Issue templates.
7. Screenshoty uzywane przez README:
   - `docs/screenshots/general_01.png`
   - `docs/screenshots/ai_fix_errors_chat.png`
   - `docs/screenshots/schema_panel.png`
   - `docs/screenshots/view_edit_data_01.png`
   - `docs/screenshots/session_monitor_01.png`
   - `docs/screenshots/session_monitor_02.png`
   - `docs/screenshots/ERD_01.png`
   - `docs/screenshots/etl_01.png`

Nie powinna zawierac:

1. `src/`
2. `media/`
3. `extensions/`
4. `packages/`
5. `dialects/`
6. `scripts/`
7. `Benchmark/`
8. `test-harness/`
9. `package.json`
10. `package-lock.json`
11. pelnej historii starego repo

## 3. Prywatne repo development/release

Prywatne repo jest miejscem dla:

1. kodu zrodlowego,
2. GitHub Actions,
3. buildow,
4. release'ow,
5. publikacji do Marketplace.

Manifesty nie powinny linkowac do prywatnego repo. W `package.json` powinny wskazywac publiczna fasade:

```json
{
  "homepage": "https://github.com/justybase/justybase-vscode",
  "bugs": {
    "url": "https://github.com/justybase/justybase-vscode/issues"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/justybase/justybase-vscode"
  }
}
```

## 4. Lokalny remote

Ten punkt wymaga recznej weryfikacji w lokalnym klonie.

Sprawdz:

```bash
git remote -v
```

Jesli `origin` nadal wskazuje stare repo, ustaw go na prywatne repo organizacji:

```bash
git remote set-url origin https://github.com/justybase/justybase-vscode-private.git
git remote -v
```

Marketplace manifesty nadal maja wskazywac publiczna fasade `justybase-vscode`, nie prywatny remote.

## 5. Git identity

Dla nowych commitow w prywatnym repo ustaw neutralna lokalna tozsamosc Git:

```bash
git config user.name "JustyBase Maintainers"
git config user.email "neutralny-noreply-email"
git config --get-regexp 'user\.(name|email)'
```

Nie zmieniaj globalnej konfiguracji, jesli uzywasz jej do innych projektow.

## 6. Release i publikacja

Aktualny model workflow:

1. `release.yml` tworzy release commit, tag i GitHub Release.
2. Release commit ma `[skip ci]`, zeby push wersji nie odpalal zwyklego CI drugi raz.
3. `release.yml` nie wywoluje bezposrednio `publish-marketplace.yml`.
4. Publikacja Marketplace startuje raz przez event `release.published`.
5. `publish-marketplace.yml` domyslnie publikuje tylko core extension.
6. Przy recznym uruchomieniu workflow optional extensions publikuje sie przez zaznaczenie checkboxow dla konkretnych rozszerzen.
7. Dla wywolan `workflow_call` nadal dostepny jest tekstowy parametr `publish_targets`.
8. Przed publikacja zawsze przechodzi `quality-gate`:
   - `npm run lint`
   - `npm run check-types`
9. Przed buildem/publikacja zawsze przechodzi szybki `test-gate` bez live baz:
   - `npm run test:completion-parity`
   - `npm run test:quickfix-regression`
   - celowane unit testy dla zaznaczonych optional extensions

Domyslne checkboxy przy recznym uruchomieniu:

1. `publish_core`: zaznaczony
2. `publish_db2`: niezaznaczony
3. `publish_duckdb`: niezaznaczony
4. `publish_oracle`: niezaznaczony
5. `publish_postgresql`: niezaznaczony
6. `publish_vertica`: niezaznaczony
7. `publish_mssql`: niezaznaczony
8. `publish_mysql`: niezaznaczony
9. `publish_snowflake`: niezaznaczony

Wartosci `publish_targets` dla `workflow_call`:

```text
core
db2
duckdb
oracle
postgresql
vertica
mssql
mysql
snowflake
all
```

## 7. Version sync

Domyslne wersjonowanie obejmuje tylko:

1. core package,
2. root lockfile,
3. `packages/contracts`.

To ogranicza niepotrzebne podbijanie wersji wszystkich optional extensions przy kazdym releasie core.

Domyslne komendy:

```bash
node scripts/version-sync.js check
node scripts/version-sync.js bump patch
node scripts/version-sync.js set 1.2.3
```

Jesli naprawde trzeba objac optional extensions, uzyj:

```bash
node scripts/version-sync.js check --include-optionals
node scripts/version-sync.js bump patch --include-optionals
node scripts/version-sync.js set 1.2.3 --include-optionals
```

Alias:

```bash
--all
```

## 8. README i screenshoty

README pakowany do VSIX nie powinien uzywac lokalnych sciezek `docs/screenshots/...`, bo `docs/` jest wykluczone z paczki.

Obrazki w `README.md` powinny wskazywac publiczna fasade:

```text
https://raw.githubusercontent.com/justybase/justybase-vscode/main/docs/screenshots/...
```

Screenshoty powinny byc w publicznej fasadzie pod tymi samymi sciezkami.

## 9. VSIX content policy

Core VSIX powinien zawierac tylko runtime i zasoby wymagane do dzialania rozszerzenia.

Oczekiwane kategorie w paczce:

1. `extension/dist/`
2. `extension/media/*.css`
3. `extension/media/*.svg`
4. `extension/media/fonts/*.woff2`
5. `extension/media/tanstack-*.js`
6. `extension/media/walkthrough/*.md`
7. `extension/dialects/netezza/snippets/*.code-snippets`
8. `extension/dialects/netezza/syntaxes/*.json`
9. `extension/package.json`
10. `extension/README.md`
11. `extension/LICENSE.txt`
12. ikony runtime

Nie powinno byc w VSIX:

1. `src/`
2. `docs/`
3. `.github/`
4. `scripts/`
5. `node_modules/`
6. `package-lock.json`
7. `*.map`
8. `*.ts`
9. `tsconfig*.json`
10. plikow testowych

## 10. Checklist przed releasem

1. Sprawdz wersje:

   ```bash
   node scripts/version-sync.js check
   ```

2. Sprawdz jakosc:

   ```bash
   npm run lint
   npm run check-types
   npm run test:completion-parity
   npm run test:quickfix-regression
   ```

3. Dla optional extensions uruchom celowane unit testy zwiazane z wybranym rozszerzeniem.

4. Zbuduj VSIX:

   ```bash
   npm run package -- --out /tmp/justybase-core-check.vsix
   ```

5. Sprawdz brak nadmiarowych plikow w VSIX.
6. Sprawdz, ze README w VSIX ma publiczne URL-e obrazkow.
7. Sprawdz, ze manifest wskazuje publiczna fasade:

   ```bash
   node -e "const p=require('./package.json'); console.log(p.publisher, p.name, p.homepage, p.repository?.url, p.bugs?.url)"
   ```

8. Sprawdz, ze lokalny remote wskazuje prywatne repo:

   ```bash
   git remote -v
   ```

## 11. Granice modelu

1. Ten model nie zmienia Marketplace publishera.
2. Ten model nie ukrywa `krzysztof-d` w Marketplace.
3. Ten model zachowuje auto-update obecnych uzytkownikow.
4. Ten model oddziela biezacy development od publicznej fasady.
5. Pelne odciecie Marketplace wymagaloby nowego publishera i nowego extension ID, co przerwaloby automatyczne przejscie obecnych uzytkownikow.
