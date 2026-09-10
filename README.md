# Sonorus

Selbst gehosteter Player für deine eigenen Audiodateien. Sonorus scannt einen
Musikordner, den du in den Container einhängst, und macht aus deiner
Ordnerstruktur eine begehbare Bibliothek: Interpreten, Alben, Singles, Genres,
alle Songs und deine eigenen Playlists.

Podcasts, Hörbücher und Hörspiele liegen neben der Musik in eigenen Wurzeln: ein
Unterordner je Sendung, darin die Folgen. Sie werden absichtlich aus der
Musikbibliothek herausgehalten - eine Sendung ist kein Interpret und eine Folge
ist kein Song - und tragen das eine, was ein Song nicht braucht: eine gemerkte
Position, damit eine 70-Minuten-Folge dort weitergeht, wo du aufgehört hast.

E-Books sind die fünfte Bibliothek und die einzige, die gelesen statt gehört
wird - mit einer Leseansicht im Browser und in der Android-App.

Die Oberfläche ist eine einzige Seite - zwischen Interpreten, Alben und Playlists
zu wechseln unterbricht die Wiedergabe nie. Gestalterisch ist sie lose an die
klassischen Medienplayer angelehnt (Bibliotheksbaum links, Transportleiste
unten) und behandelt die App wie ein Stück Audiotechnik: ein tiefes,
tintenfarbenes Gehäuse, ein warmer Bernsteinakzent, Abschnittsbeschriftungen im
Hi-Fi-Stil und Monospace-Anzeigen für jede Zahl. Dunkel ist der Standard; ein
helles Thema und ein "Auto"-Modus, der dem Betriebssystem folgt, sind einen
Klick entfernt.

Alles liegt hinter einer Anmeldung, es gibt keinen öffentlichen Zugang. Die
Bibliothek selbst teilen sich alle Konten, während Playlists, Sternebewertungen
und Hörverlauf dem Konto gehören, das sie angelegt hat.

## Funktionen

### Bibliothek

- **Alle Songs** - jeder Titel der Bibliothek, sortierbar und durchsuchbar. Ein
  Klick auf eine Spaltenüberschrift sortiert danach, ein zweiter dreht die
  Richtung um, und die Sortierung wird auf deinem Konto gemerkt, bis du sie
  wieder änderst.
- **Interpreten** - alle Interpreten, mit ihren Alben, Singles und Titeln.
- **Alben** - Album-Raster mit eingebettetem Cover, Titelliste je Album.
  Sortierbar nach Titel, Interpret, Jahr oder Anzahl der Songs, jeweils in beide
  Richtungen ("Titel Z-A", "Jahr, älteste zuerst"), und die Wahl wird gemerkt wie
  die auf Alle Songs.
- **Cover groß ansehen** - ein Klick auf das Bild einer Album- oder
  Interpretenseite öffnet es in voller Größe; ein Klick irgendwohin oder Escape
  schließt es wieder.
- **Suche** - eine Frage, nicht drei. Eine Anfrage wird in Wörter zerlegt und
  jedes Wort muss irgendwo passen; in welchem Feld, ist frei - "Fame Bowie
  Americans" findet also den Song *Fame* von David Bowie auf *Young Americans*.
  Die Treffer sind gewichtet statt alphabetisch: Wer "Fame" sucht, bekommt die
  Songs, die Fame heißen, über die, die nur auf einem Album namens "The Fame
  Monster" liegen.
- **Genres** - alles nach Genre gruppiert (Mehrfach-Tags werden unterstützt).
  Jede Karte im Raster trägt dasselbe Bild wie die Seite, zu der sie führt,
  Singles eingeschlossen: Ein Genre aus losen Dateien nimmt seine Cover aus den
  Dateien.
- **Eine Sammlung wird vorgestellt wie ein Album.** Eine Playlist, eine
  Sterne-Playlist und ein Genre tragen denselben Kopf wie eine Albumseite: das
  Bild links vom Namen, was es zusammen ergibt, und die Abspielknöpfe. Ohne
  eigenes Bild ist die Kachel ein 2x2-Mosaik aus den Covern der ersten vier
  Platten darin - bei weniger als vier steht das erste Cover allein.
- **Mehrere Genres auf einmal.** Über einer Genreseite steht eine Reihe
  Schalter, einer je Genre: Schalte Rock und Jazz dazu und du bekommst eine
  kombinierte Liste aus beidem (`/genres/1,4`), jeden Song darin einmal. Dieselbe
  Idee wie bei den Sterne-Playlists weiter unten. Eine Bibliothek mit hundert
  Genres ergibt eine sehr hohe Reihe, deshalb ist sie auf drei Zeilen gedeckelt
  und klappt auf Wunsch auf - und was eingeschaltet ist, wird zuerst gezeichnet,
  damit nie die aktuelle Auswahl der versteckte Teil ist.
- **Die Ordnerstruktur ist die Bibliothek.** Interpret, Album, Titelnummer und
  Titel kommen aus dem Aufbau, nicht aus den Datei-Tags:

  ```
  music/
    Twenty One Pilots/
      Vessel/
        01 - Ode to Sleep.flac     Albumtitel, Nummer 1 von "Vessel"
        02 - Holding on to You.flac
      Heathens.flac                Single: kein Album, eigener "Singles"-Ordner
  ```

  Ein Ordner direkt unter dem Musikordner ist ein Interpret, ein Ordner darin ein
  Album, und eine führende Zahl im Dateinamen ist die Titelnummer (`01 - Titel`,
  `01 Titel`, `1-01 Titel` für CD 1). Dateien, die lose in einem
  Interpretenordner liegen, sind Singles: Sie gehören zu keinem Album und werden
  auch nicht als eines gezählt. Ein `CD1`- oder `Disc 2`-Ordner innerhalb eines
  Albums liefert nur die CD-Nummer.
- **Sampler gehören unter `Various`.** Dieser eine Interpretenordner wird anders
  gelesen: Ein Album darin ist ein Sampler, bei dem jeder Song einen eigenen
  Interpreten hat, und der Dateiname sagt zwischen Titelnummer und Titel, welchen.

  ```
  music/
    Various/
      Crywank Covers/
        01 - Lovejoy - Privately Owned Spiral Galaxy.flac
  ```

  Das Album bleibt unter Various, der Song zeigt "Lovejoy". Getrennt wird nur am
  **ersten** ` - ` nach der Nummer, ein Titel behält also jeden eigenen
  Bindestrich (`02 - Crywank - James Is Dead - Long Live James` ist "James Is Dead
  - Long Live James" von Crywank), und ein Bindestrich ohne Leerzeichen bleibt
  Teil des Namens (`Jay-Z`). Eine Datei, die keinen Interpreten nennt, gehört zu
  Various wie jeder andere Titel. Überall sonst ist ein Bindestrich im Titel
  einfach ein Bindestrich - das hier gilt für diesen einen Ordnernamen und sonst
  nirgends.
- **Ein Name darf mit einem Punkt beginnen - maskiert mit einem
  Backslash.** Alles, dessen Name mit einem Punkt beginnt, ist versteckt und wird
  nicht gescannt, was ein Album wie `...Baby One More Time` verlieren würde. Nenn
  den Ordner (oder die Datei) stattdessen `\...Baby One More Time`: Der Backslash
  nimmt das Verstecken weg, und Sonorus lässt ihn wieder fallen, die Bibliothek
  zeigt also `...Baby One More Time`. Gilt für Interpretenordner, Albumordner und
  Dateinamen gleichermaßen. Ein Name, der weiterhin mit einem echten Punkt
  beginnt, bleibt absichtlich versteckt - so hält man einen Ordner aus der
  Bibliothek heraus.
- Was ein Ordnername nicht sagen kann, wird weiterhin aus der Datei gelesen
  (ID3v1/ID3v2, Vorbis-Kommentare, MP4-Atome, APE): Erscheinungsdatum, Genre,
  Länge, Format, Songtext und das eingebettete Cover. Ein Album, dessen Dateien
  alle kein Bild eingebettet haben, nimmt eine `cover.jpg` / `folder.jpg` /
  `front.jpg` aus dem Albumordner. Songtexte werden aus `USLT` / `SYLT` /
  `LYRICS` und ihren Entsprechungen gelesen, und ein Text im LRC-Format
  (`[01:23.45]` je Zeile) behält seine Zeitmarken, kann dem Song also folgen.
  Sonorus holt nie etwas aus dem Internet: Was die Dateien nicht tragen,
  existiert für Sonorus nicht.
- **Das Erscheinungsdatum wird so genau behalten, wie die Datei es kennt** - ein
  ganzer Tag, ein Monat oder ein nacktes Jahr. Die **Albumseite** ist der eine
  Ort, der es ausschreibt ("17. Mai 2013"); jede Liste, jedes Raster und jede
  Karte zeigt das Jahr, mehr passt dort nicht hin. Eine Datei, die nur ein Jahr
  trägt, zeigt deshalb auch immer nur eines.
- **Alben bearbeiten** - die Albumseite hat einen "Bearbeiten"-Knopf für die drei
  Dinge, die die Ordnernamen nicht sagen können: Erscheinungsdatum, Genres (per
  Komma getrennt, gelten für jeden Titel des Albums) und das Cover (JPG, PNG oder
  WebP, im Dialog hochgeladen). Das Datum wird so genau eingetippt, wie es bekannt
  ist - `17.05.2013`, `05.2013` oder `2013`. Die Änderung liegt in Sonorus,
  **niemals in deinen Dateien** - der Musikordner bleibt nur lesbar - und jedes
  geänderte Feld wird gesperrt, damit ein späterer Scan nicht die Version der
  Datei zurückschreibt. Titel, Interpret und Titelnummer sind nicht änderbar: Sie
  kommen aus der Ordnerstruktur, die der nächste Scan wieder liest.
  - **Die Änderung gehört dem Album, nicht den Songs, die heute darin
    liegen.** Benenne eine Datei um, tagge sie neu, leg eine neue in den Ordner -
    Datum, Genres und Cover des Albums gelten weiter, und ein Song, der später
    dazukommt, bekommt sie genauso. Das ist der Unterschied zum Bearbeiten von
    Datei-Tags: Nichts, was du mit den Dateien tust, nimmt die Änderung zurück.
    Nur der **Ordnername** des Albums kann das, denn ein umbenannter Ordner ist
    für Sonorus ein anderes Album.
- **Singles bearbeiten** - eine Single gehört zu keinem Album, also kann nichts
  anderes ihr Erscheinungsdatum, ihre Genres oder ihr Cover tragen: Die Liste
  unter "Singles" hat eine Jahr-Spalte, und "Single bearbeiten" im Kontextmenü des
  Titels setzt alle drei. Genres per Komma getrennt wie bei einem Album, ein
  leeres Feld entfernt sie. Gesperrt und nie in die Datei geschrieben, genau wie
  bei einem Album. Der Singles-Ordner selbst hat kein Jahr - nur die Songs darin.
- **Interpret bearbeiten** - die Interpretenseite hat einen "Bearbeiten"-Knopf für
  das Profilbild. Ohne eines leiht sich der Interpret weiterhin das Cover eines
  seiner Alben. Der Name ist nicht änderbar: Er ist der Name des Ordners, und der
  nächste Scan würde ihn zurücklesen.
- **Bildausschnitt verschieben** - ein Bild, das nicht genau quadratisch ist, wird
  **im Rahmen des Dialogs gezogen**, um zu wählen, welches Quadrat daraus das
  Cover wird: links und rechts bei einem breiten Bild, hoch und runter bei einem
  hohen. Der Rahmen zeigt das Ergebnis beim Ziehen, und genau dieses Quadrat wird
  gespeichert - Cover werden in jedem Raster, auf der Detailseite und in der
  Benachrichtigung des Handys quadratisch gezeigt, der Ausschnitt wird also einmal
  entschieden, wenn das Bild dazukommt. Gilt für Album-, Single- und
  Interpretenbilder gleichermaßen.
- Jedes hochgeladene Bild (Album, Single, Interpret) wird **im Browser
  verkleinert** auf höchstens 1000 px an der längeren Seite und als JPEG neu
  kodiert, bevor es abgeschickt wird. Größer wird ein Cover nie gezeigt, und es
  hält den Upload klein genug, dass ein Reverse Proxy vor Sonorus ihn durchlässt -
  nginx zum Beispiel erlaubt standardmäßig 1 MB Anfragekörper.
- Erneuter Scan auf Zuruf aus den Einstellungen; unveränderte Dateien werden
  übersprungen, entfernte Dateien verschwinden aus der Bibliothek - **außer du
  hast sie bewertet, in eine Playlist gelegt oder gehört.** Die behalten ihre
  Zeile und werden ausgegraut und durchgestrichen gezeigt, mit dem zuletzt
  bekannten Pfad im Tooltip, damit eine Bewertung nie an eine verschobene Datei
  verloren geht. Leg die Datei zurück, und der nächste Scan nimmt die Markierung
  weg.

### Podcasts

Gesprochenes wird aus `PODCAST_DIR` gescannt, einer Wurzel neben `MUSIC_DIR`.
Der Aufbau ist ein Ordner je Sendung, jede Audiodatei darin eine Folge:

```
podcasts/
  Some Show/
    #001 Erste Folge.mp3
    #002 Zweite Folge.mp3
```

- **Sendungen** - jede Sendung, als Kacheln oder als Liste, mit der Zahl ihrer
  noch ungehörten Folgen.
- **Folgen** - die Folgenliste einer Sendung, standardmäßig neueste zuerst und
  umschaltbar auf älteste zuerst; die Wahl wird auf deinem Konto gemerkt. Die
  Reihenfolge liest zuerst die Nummer vor dem Dateinamen (`#001`) und dann das
  Veröffentlichungsdatum, eine Sendung ohne Nummerierung sortiert sich also
  trotzdem so, wie sie erschienen ist.
- **Weiterhören** - jede angefangene Folge, über alle Sendungen hinweg, zuletzt
  gehörte zuerst. Eine davon zu spielen setzt sie auf die Sekunde fort, an der du
  aufgehört hast; eine bis zum Ende gehörte Folge gilt als gehört, und eine, die
  du in den letzten 30 Sekunden gestoppt hast, auch. Beides lässt sich im
  Zeilenmenü von Hand setzen.
- Folgen sind **nicht Teil der Musikbibliothek**: Sie tauchen nie unter Alle
  Songs, Interpreten, Alben, Genres, den Sterne-Playlists, dem Zufallsmix oder
  den musikförmigen Listen der Statistik auf, und sie werden weder bewertet noch
  in Playlists gelegt. Die Suche findet sie, in einem eigenen Abschnitt. Ihre
  Hörzeit zählt auf der Statistikseite mit, in einer eigenen Zeile - siehe
  Statistik.
- **Das Bild gehört der Sendung**, nicht der Folge. Ein Podcast wechselt über die
  Jahre sein Erscheinungsbild, statt je Folge ein Cover zu zeichnen; eine Handvoll
  Bilder je Folge zu speichern hieße, dieselben Bilder hundertfach abzulegen.
- Von der Folgen-Reihenfolge abgesehen redet hier nichts mit dem Internet. Wie
  bei der Musik kommt alles, was Sonorus über einen Podcast weiß, aus den Dateien
  selbst.

### Hörbücher

Hörbücher werden aus `AUDIOBOOK_DIR` gescannt, einer dritten Wurzel. Ein Ordner
je Autor, darin ein Ordner je Buch, darin die Audiodateien:

```
audiobooks/
  Umberto Eco/
    Der Name der Rose/
      01 - Kapitel 1.mp3
      02 - Kapitel 2.mp3
```

**Ein Buch ist eine Sache, und die Dateien, aus denen es besteht, werden nie
gezeigt.** Wie viele Teile der Rip auch hergegeben hat - vierzig oder einen -,
die Buchseite hat ein Cover, einen Autor, eine Länge und einen einzigen Knopf,
sonst nichts. Es gibt keine Teileliste, und du musst vorher nichts
zusammenfügen: Die Teile werden der Reihe nach eingereiht und laufen durch.

- **Autoren** - jeder Autor, als Kacheln oder als Liste, mit der Zahl seiner
  Bücher. Dahinter seine Bücher, dahinter das Buch selbst.
- **Weiterhören** - jedes angefangene Buch, zuletzt gehörtes zuerst.
- Die Position wird **über Dateigrenzen hinweg** gehalten: "44 Sek. von 4 Min."
  zählt die bereits gehörten Teile plus die Sekunden im aktuellen, und
  Fortsetzen öffnet die richtige Datei an der richtigen Sekunde. Die Reihenfolge
  folgt der Nummer vor dem Dateinamen, wo es eine gibt, und sonst dem Dateinamen.
- **Als gehört markieren** gilt für das ganze Buch, weil die Oberfläche keine
  andere Einheit anbietet.
- **Kapitel**, wo die Dateien sie tragen. Eine `.m4b` nach Audible-Art ist eine
  einzige Datei von bis zu fünfzig Stunden mit den Marken darin, und Sonorus
  liest sie mit `ffprobe`. Die Transportleiste nennt dann das Kapitel, wo ein Song
  seinen Titel hat, das Buch, wo er seinen Interpreten hat, und den Autor, wo er
  sein Album hat; die Suchleiste trägt eine Haarlinie an jedem Kapitelanfang; die
  Sprungtasten und die Medientasten gehen ein Kapitel weiter; und die Leiste
  rechts ist die Kapitelliste statt Warteschlange und Songtext, für die ein Buch
  keine Verwendung hat. Ein Buch, dessen Dateien keine Marken tragen, behält
  seinen Titel und einen langen Balken, genau wie vorher.
- **Gesprochen von** und das **Erscheinungsdatum**, aus der Datei gelesen
  (`composer` und `date`, was eine Audible-`.m4b` trägt) und unter "Bearbeiten"
  änderbar - der Tag kennt das Jahr, du kennst vielleicht den Tag. Ein Autor kann
  ein eigenes Bild bekommen, so wie ein Interpret.
- Wie Podcasts sind Bücher **nicht Teil der Musikbibliothek** und werden weder
  bewertet noch in Playlists gelegt. Die Suche findet sie in einem eigenen
  Abschnitt.

Eines ist wissenswert: Der Übergang zwischen zwei Teilen ist nicht lückenlos. Der
Browser muss die nächste Datei öffnen, was den Bruchteil einer Sekunde kostet -
am Kapitelende praktisch nicht zu merken, aber eben nicht dasselbe wie eine
durchgehende Datei.

### Hörspiele

Hörspiele werden aus `AUDIODRAMA_DIR` gescannt, einer vierten Wurzel, genauso
aufgebaut wie die Hörbücher - ein Ordner je Autor, darin ein Ordner je Hörspiel:

```
audiodramas/
  Sebastian Fitzek/
    Passagier 23/
      Passagier 23.m4b
```

Sie bekommen einen eigenen Tab, eine eigene Autorenliste und einen eigenen
Abschnitt in der Suche, denn ein Hörspiel ist etwas anderes, wofür man sich
hinsetzt, als ein Buch. Hinter der Oberfläche sind es dieselben Zeilen wie ein
Hörbuch und sie verhalten sich gleich: eine Sache für den Hörer, die Teile nie
gezeigt, die Position gemerkt, Kapitel, wo die Dateien sie tragen.

**Der eine Unterschied ist der Sprecher.** Ein Hörspiel hat eine Besetzung, keinen
Vorleser, also trägt es keine "Gesprochen von"-Zeile und sein Bearbeiten-Dialog
kein solches Feld - eine Liste von sechs Schauspielern unter dieser Überschrift
läse sich wie eine Person, die ihre Sache schlecht macht. Das Erscheinungsdatum
funktioniert genau wie bei einem Buch.

### E-Books

E-Books werden aus `EBOOK_DIR` gescannt, einer fünften Wurzel, aufgebaut wie die
Hörbücher - ein Ordner je Autor, darin ein Ordner je Buch. Gelesen wird nur
`.epub`:

```
ebooks/
  Suzanne Collins/
    The Ballad of Songbirds and Snakes/
      The Ballad of Songbirds and Snakes.epub
```

Ein Buch wird gelesen statt gespielt, es hat also keine Warteschlange, keine
Bewertung und keine Playlist. Was es hat, ist eine Leseansicht: Das EPUB wird auf
dem Server ausgepackt und jedes Dokument als eigene Seite ausgeliefert, in Spalten
umbrochen - ein Tipp auf die rechte Hälfte blättert vor, einer auf die linke
zurück. Schriftart, Größe, Zeilenabstand und Rand gehören dem Leser; Ubuntu
kommt vom Server, es muss also nichts auf dem Gerät installiert sein.

**Dieselbe Leseansicht läuft im Browser und in der Android-App.** Sie liegt in
`public/reader/` und spricht mit dem, der sie hält, über zwei Objekte:
`window.Reader` hinein und `window.SonorusReader` heraus. Der Browser hängt sein
eigenes Objekt in einen Frame gleichen Ursprungs, die App in eine WebView - die
Seite selbst ist beide Male dieselbe.

- **Ein Buch wird über Titel und Autor erkannt, nicht über seinen Pfad**, eine
  umbenannte Datei ist also weiterhin dasselbe Buch und behält ihren Lesestand.
- **Die Stelle ist ein Anteil eines Dokuments, keine Seitenzahl.** Eine Seite ist,
  was bei der gewählten Größe auf den Bildschirm passt, sie bedeutet auf dem
  nächsten Gerät also nichts; der Anteil bedeutet überall dasselbe.
- **Die Seitenzahl des ganzen Buchs wird gemessen.** Ein EPUB hat keine, also wird
  jedes Kapitel einmal unsichtbar gesetzt und gezählt, gespeichert je Buch,
  Schrift und Fenstergröße. Bis das durch ist, steht dort eine Schätzung aus den
  Zeichenzahlen, damit ein Buch aufgeht, statt zu laden.
- **Eine ziehbare Fortschrittsleiste** durch das ganze Buch, und danach ein Weg
  zurück an die verlassene Stelle.
- **Das Jahr eines Buchs ist änderbar** und wird dann gesperrt, damit der nächste
  Scan nicht das falsche Jahr aus der Datei zurückschreibt. Ein Autor kann ein
  eigenes Bild bekommen - es ist derselbe Autor wie beim Hörbuch, beide Regale
  lesen dieselbe Tabelle.
- Inhaltsverzeichnisse werden sowohl aus EPUB 2 (`toc.ncx`) als auch aus EPUB 3
  (`nav`) gelesen.
- Die Android-App kann ein Buch **herunterladen** und dann ohne Server lesen -
  siehe das README dort.

### Wiedergabe

- Play/Pause, vorheriger/nächster Titel, verstrichene und gesamte Zeit. "Zurück"
  beginnt den laufenden Titel von vorn, sobald er mehr als drei Sekunden läuft;
  noch einmal gedrückt geht es zu dem Titel, der wirklich davor lief, Zufall
  eingeschlossen.
- Die Suchleiste ist die Oberkante der Transportleiste: volle Breite, überall zu
  greifen.
- Zufall und Wiederholung (aus / alle wiederholen / eines wiederholen).
- Lautstärkeregler mit Stummschaltung. Das Mausrad darüber funktioniert auch:
  nach oben ist lauter.
- **Zu Playlist hinzufügen** - ein Plus neben den Sternen des Laufenden legt den
  Song auf eine deiner Playlists. Nur Playlists: Die Bewertung sitzt direkt
  daneben, und das Menü des Titels trägt alles Übrige.
- **Aktuelle Wiedergabeliste** - die laufende Warteschlange in einer Seitenleiste,
  die die echte kommende Reihenfolge zeigt, auch bei eingeschaltetem Zufall;
  ziehen zum Umsortieren, klicken zum Springen.
- **Songtext** - der Text, den eine Datei trägt, in einer Leiste neben der
  Warteschlange. Sagt die Datei auch, wann welche Zeile gesungen wird, ist die
  laufende Zeile hervorgehoben und die Leiste scrollt mit; sie hört für ein paar
  Sekunden auf zu folgen, wenn du selbst woanders hinscrollst. Eine Zeile
  erscheint eine Sekunde, bevor sie gesungen wird, so wie ein Karaoke-Vorlauf, und
  ein Klick darauf springt den Song dorthin. Ohne Zeitmarken steht der ganze Text
  einfach da. Nichts wird von irgendwoher geholt - eine Datei, deren Tags keinen
  Text tragen, hat hier keinen.
- **Versatz** - Dateien sind sich uneinig, wo eine Zeile hingehört, also lässt
  sich jeder Song einzeln korrigieren, in Zehntelsekunden und in beide
  Richtungen. Das Bedienelement liegt über dem laufenden Text statt in einem
  Dialog: Nichts hält an, solange es offen ist, und nur so sieht man, ob die Zahl
  stimmt. Null ist die Sekunde Vorlauf von oben, nicht die Marke der Datei
  selbst. Die Korrektur liegt je Song auf dem Server, gilt also für jedes Konto,
  jeden Client und jedes nächste Mal.
- Eine Pegelanzeige in der Transportleiste und eine **große Ansicht** für das
  Laufende, geöffnet mit einem Klick auf den Titel in der Leiste (oder mit `V`).
  Sie nimmt den Inhaltsbereich und lässt Seitenleiste und Kopfzeile stehen, und
  sie trägt drei Reiter: den Song mit seinem Bild, seinen Text und einen
  Visualizer, der vom echten Ton durch einen Web-Audio-Analyser getrieben wird.
- Media-Session-Unterstützung, damit Sperrbildschirm und Medientasten den
  laufenden Titel zeigen und tun, was man erwartet: die Karte mit Cover, Zurück
  und Weiter, und die Fortschrittsleiste, die die Benachrichtigung aus der
  gemeldeten Position zeichnet. Ob die Benachrichtigung das alles dann zeigt,
  entscheidet der Browser. Bietet sie nur Pause an, wurde die Seite mit ziemlicher
  Sicherheit über einfaches HTTP geöffnet, wo es die Media-Session-API gar nicht
  gibt.
- Warteschlange, Lautstärke und die Zufalls-/Wiederholungsmodi überleben ein
  Neuladen. Lautstärke, Zufall und Wiederholung liegen auf dem Konto, folgen dir
  also auf ein anderes Gerät; die Warteschlange selbst bleibt in dem Browser, in
  dem du sie gebaut hast.
- **Qualität** - unter Einstellungen wählst du, ob dieses Gerät die Originaldatei
  streamt oder eine kleinere Kopie mit Opus 128 kbps. Die Wahl gilt pro **Gerät**,
  nicht pro Konto: Sie liegt im Browser, denn ein Rechner im eigenen Netz und ein
  Laptop im Hotel-WLAN wollen nicht dasselbe. Eine Änderung öffnet den laufenden
  Titel dort wieder, wo er steht, du kannst den Unterschied also hören, ohne die
  Musik anzuhalten.

### Am Handy

Die ganze App ist ein Layout; unter 900 px ordnet sie sich um, statt Funktionen
wegzulassen.

- **Die Transportleiste öffnet sich als Vollbild.** Tippe auf das Laufende, und
  die Leiste wird ein Bildschirm mit großem Bild, den Sternen und einer
  Suchleiste, die ein Daumen trifft. Sie kommt und geht wie ein Blatt, und ein
  Wisch nach unten über das Bild folgt dem Finger.
- **Die gerade gesungene Zeile** steht in diesem Vollbild zwischen Bild und
  Titel, bei einem Song, dessen Text Zeitmarken trägt. Ein Tipp darauf öffnet den
  Rest.
- **Die Zurück-Taste schließt, was über der Seite liegt** - das Vollbild, die
  Schublade, die Warteschlange, den Songtext, einen Dialog, ein Menü - bevor sie
  die App verlässt.
- **Einen Titel gedrückt zu halten öffnet sein Menü**, dasselbe, das der
  "..."-Knopf öffnet, als Blatt von der Unterkante. Ein Tipp auf die Zeile spielt
  ihn.
- **Bewertet** wird im Vollbild-Player oder über "Bewerten …" in jenem Menü; unter
  560 px hat die Sternespalte in der Titelliste keinen Platz. Darüber bleibt sie -
  ein Fenster auf halbem Bildschirm behält Bewertung, Zeitanzeige und die
  Bedienelemente rechts in der Leiste, und stattdessen wird der Titel
  abgeschnitten. Ein abgeschnittener Titel nennt seinen vollen Namen beim
  Überfahren.
- Die Suchleiste lässt sich ziehen, das Thema wird unter Einstellungen gewählt,
  und nichts behält nach einem Tipp einen Hover-Zustand.
- Auf dem Desktop klappt die Seitenleiste weg, und Interpreten, Alben und Genres
  lassen sich als Kacheln oder als eine Zeile je Eintrag zeigen. Beide Wahlen
  liegen auf dem Konto, die Listen-/Kachelwahl je Sammlung.

### Tastenkürzel

| Taste | Wirkung |
| --- | --- |
| `Leertaste` | Play / Pause |
| `←` / `→` | 5 Sekunden zurück / vor |
| `Umschalt` + `←` / `→` | Vorheriger / nächster Titel |
| `1` - `5` | Den laufenden Titel bewerten |
| `0` | Bewertung löschen |
| `S` | Zufall an/aus |
| `R` | Wiederholung durchschalten |
| `M` | Stumm |
| `Q` | Warteschlange zeigen / verstecken |
| `L` | Songtext zeigen / verstecken |
| `V` | Große Ansicht zeigen / verstecken |
| `/` | Ins Suchfeld springen |

### Playlists

- Playlists anlegen, umbenennen und löschen; Titel aus jeder Ansicht hinzufügen.
- **Playlist-Ordner**, um Playlists in der Seitenleiste zu gruppieren.
- Ziehen und Ablegen, um Titel innerhalb einer Playlist umzusortieren.
- **Ziehen und Ablegen in der Seitenleiste**, um die Playlists selbst zu ordnen:
  hoch und runter innerhalb ihrer Liste, auf einen Ordner, um sie
  hineinzuschieben, oder wieder heraus auf die oberste Ebene. Die Reihenfolge
  liegt auf deinem Konto.
- **Anpinnen** hält eine Playlist oben in ihrer Liste, mit einer Nadel markiert.
  Rechtsklick in der Seitenleiste, oder der Knopf auf der Playlist-Seite.
- **Sterne-Playlists** - bewerte jeden Titel von 1 bis 5 Sternen, aus jeder
  Titelliste oder aus der Transportleiste; Sonorus hält je Bewertung eine
  automatische Playlist, die immer den aktuellen Stand zeigt. Ein Klick auf die
  aktuelle Bewertung eines Titels löscht sie wieder. **Nicht bewertet** ist das
  Gegenstück: alles, was noch auf eine Bewertung wartet. Einen Titel dort zu
  bewerten nimmt ihn aus der Liste, **deine Stelle in der Liste bleibt aber** -
  ein paar hundert unbewertete Songs durchzuarbeiten wirft dich nicht nach jedem
  Stern wieder nach oben.
- **Mehrere Bewertungen auf einmal.** Über jeder Sterne-Playlist steht eine Reihe
  Schalter, einer je Bewertung: Schalte 4 und 5 an und du bekommst eine
  kombinierte Liste aus beidem (`/stars/5,4`), bestbewertete zuerst. "Nicht
  bewertet" darf mitmachen.
- **Die Sterne eines Interpreten.** Die Interpretenseite trägt dieselben Schalter
  unter "Nach Bewertung", einen je Bewertung, die dieser Interpret wirklich hat:
  Ein Klick gibt dir nur die 5-Sterne-Songs dieses Interpreten
  (`/artists/7/stars/5`), und sie kombinieren sich genauso
  (`/artists/7/stars/5,4`). Die Liste behält die Reihenfolge der
  Interpretenseite.
- **Unbewertete mischen** - der zweite Knopf auf der Startseite, neben "Zufallsmix
  starten": ein Zufallslauf durch alles, was noch keinen Stern hat. Eine
  Bibliothek zu bewerten ist Arbeit nach Gehör, und das hier erspart es, den
  nächsten Titel aus einer Liste von ein paar tausend von Hand zu suchen. Er
  erscheint nur, solange es überhaupt noch etwas zu bewerten gibt.
- Automatische Ansichten für zuletzt hinzugefügt, zuletzt gehört und meistgehört.
  "Am häufigsten gehört" heißt gehörte Zeit, nicht Anzahl der Starts - ein
  zwanzigminütiges Stück zweimal gehört ist mehr Hören als ein Dreiminüter fünfmal.
  Die Songs eines Interpreten sind genauso geordnet.

### Statistik

Eine eigene Seite, neben den Einstellungen. Der Hörverlauf liegt auf dem Server
und gehört dem Konto, Handy und Desktop zählen also in dieselben Zahlen.

- Die Bibliothek auf einen Blick: Songs, Interpreten, Alben, Singles, Genres,
  Gesamtspielzeit.
- **Gesprochenes**, dasselbe für die drei gesprochenen Bibliotheken: Sendungen und
  Folgen, Bücher und Autoren, Hörspiele und Autoren, jeweils mit Länge und dem,
  was davon noch ungehört ist. Jede Zeile führt in diese Bibliothek.
- Gehörte Zeit insgesamt, seit der ersten Wiedergabe, mit der Zahl der Tage, an
  denen wirklich etwas lief, und dem Tag, an dem am meisten lief.
- Durchschnitte: pro Tag (stille Tage eingerechnet), pro Tag mit Wiedergabe, pro
  Wiedergabe und Wiedergaben pro Tag. **Gemessen, nie hochgerechnet** - es gibt
  kein "pro Jahr" nach zwei Tagen Hören.
- Ein Säulendiagramm der gehörten Zeit, nach Tag, Woche, Monat oder Jahr, mit der
  Zeit über und der Zahl der Wiedergaben unter jeder Säule. Ein Zeitraum, in dem
  nichts lief, wird als die Null gezeigt, die er ist, statt weggelassen zu
  werden.
- **Eine Wiedergabe wird über die Stunden verteilt, durch die sie wirklich lief.**
  Ein Hörspiel, das um 14:40 beginnt und zweieinhalb Stunden läuft, sind zwanzig
  Minuten in der 14-Uhr-Säule, je eine Stunde in 15 und 16 Uhr und zehn Minuten in
  17 Uhr - keine Säule kann also mehr als sechzig Minuten tragen, und eine
  Wiedergabe über Mitternacht landet auf beiden Tagen. Gezählt wird sie trotzdem
  als **eine** Wiedergabe.
- **Die Uhr ist die des Servers.** Welche Stunde, welcher Tag und welches Jahr
  eine Wiedergabe bekommt, entscheidet der Server, damit dieselbe Vergangenheit
  auf jedem Gerät und in jedem Land gleich aussieht. Deshalb muss `TZ` gesetzt
  sein - ein Container ohne läuft auf UTC.
- **Spielzeit**, der gewählte Zeitraum nach Bibliothek aufgeteilt: Musik,
  Podcasts, Hörbücher, Hörspiele und die Summe, jeweils mit Anteil, Zahl der
  Wiedergaben und Zeit. Eine Bibliothek, die still war, behält ihre Zeile - das
  ist es, was sagt, dass sie hier überhaupt gezählt wird.
- Die meistgehörten Titel, Interpreten und Alben, mit Zahl und Zeit. Diese drei
  bleiben **nur Musik**: Eine 70-Minuten-Folge wiegt ein Dutzend Songs auf, und
  eine gemischte Liste wäre eine Liste von Podcasts.
- **Meistgehörtes Gesprochenes**, eine Liste für alle drei gesprochenen
  Bibliotheken. Gereiht wird die Sendung, das Buch oder das Hörspiel - nie die
  Datei, denn ein Buch ist eine Sache, deren Teile nie gezeigt werden.

Eine Wiedergabe zählt, sobald ein Titel 30 Sekunden gelaufen ist - bei Titeln,
die kürzer sind und die Marke nie erreichen können, ein Drittel ihrer Länge.
Gezählt wird die **wirklich gehörte Zeit**: Der Player meldet weiter, wie weit er
tatsächlich kam, eine Minute und dann weggeklickt zählt also als eine Minute und
nicht als ganzer Titel. Das gilt für jede Bibliothek: Eine Folge und ein Buchteil
werden genauso gezählt wie ein Song, und deshalb ist die Gesamtspielzeit die
Gesamtspielzeit.

### CSV-Import

Aus einem Streamingdienst exportierte Playlists lassen sich als CSV importieren.
Erwartete Spalten (Kopfzeile nötig, Reihenfolge egal):

| Spalte | Bedeutung | Ebenfalls akzeptiert |
| --- | --- | --- |
| `playlist` | Name der Playlist; eine CSV darf mehrere enthalten | `playlist name` |
| `title` | Titel | `track name`, `track`, `song`, `name`, `titel` |
| `artists` | Interpret, oder mehrere per Komma getrennt | `artist`, `artist name(s)`, `interpret` |
| `album` | Albumtitel | `album name` |

Nur `title` ist Pflicht. Komma-, Semikolon- und Tab-getrennte Dateien werden
gleichermaßen erkannt, ebenso Felder in Anführungszeichen und ein UTF-8-BOM. Ohne
`playlist`-Spalte wird die ganze Datei zu einer Playlist, benannt nach der Datei.

Sonorus gleicht jede Zeile in vier Durchgängen gegen die Bibliothek ab, streng
zuerst:

1. Titel und Interpret exakt,
2. Titel und Interpret, wobei Groß-/Kleinschreibung, Akzente, Satzzeichen und
   Versionszusätze (`- Remastered 2011`, `(Live)`, `- Single Version`) ignoriert
   werden,
3. derselbe lose Titel zusammen mit dem Album,
4. der lose Titel allein, aber nur, wenn er in der Bibliothek eindeutig ist.

Getroffene Zeilen wandern in die Playlist.

Zeilen, die nicht zugeordnet werden können, fallen **nicht** stillschweigend
unter den Tisch: Sie werden als Import-Hinweise festgehalten und bleiben unter
**Einstellungen -> Mitteilungen** sichtbar, mit Playlist, Titel, Interpret und
Album, damit du genau weißt, welche Songs in deiner Bibliothek fehlen. Einträge
bleiben, bis du sie wegklickst, und verschwinden von selbst, sobald bei einem
späteren Scan eine passende Datei auftaucht.

## Schnellstart (Docker)

```bash
git clone https://github.com/flopsyan/sonorus.git
cd sonorus
cp .env.example .env      # MUSIC_DIR setzen (und PODCAST_DIR, falls vorhanden)
docker compose up -d --build
```

http://localhost:3000 öffnen. Beim ersten Besuch führt dich eine einmalige
Einrichtungsseite durch das Anlegen des ersten Administratorkontos. Danach
anmelden und weitere Konten über das Kontomenü hinter deinem Avatar verwalten
(nur Administratoren - niemand sonst sieht die Kontenliste).

Alternativ lässt sich der erste Administrator ohne Nachfragen anlegen, indem du
vor dem ersten Start `AUTH_PASSWORD` (und optional `AUTH_USER`) in `.env` setzt.

Der erste Scan startet von selbst, solange die Bibliothek leer ist; weitere Scans
lassen sich jederzeit unter **Einstellungen** auslösen.

## Konfiguration

Alle Einstellungen kommen aus der Umgebung (siehe `.env.example`):

| Variable | Standard | Zweck |
| --- | --- | --- |
| `MUSIC_DIR` | `./music` | Host-Pfad deines Musikordners, nur lesend in den Container eingehängt |
| `PODCAST_DIR` | `./podcasts` | Host-Pfad deines Podcast-Ordners (ein Unterordner je Sendung), nur lesend. Darf ins Leere zeigen; er darf nicht innerhalb von `MUSIC_DIR` liegen |
| `AUDIOBOOK_DIR` | `./audiobooks` | Host-Pfad deines Hörbuch-Ordners (ein Ordner je Autor, darin einer je Buch), nur lesend. Dieselben Regeln wie `PODCAST_DIR` |
| `AUDIODRAMA_DIR` | `./audiodramas` | Host-Pfad deines Hörspiel-Ordners, aufgebaut wie `AUDIOBOOK_DIR`, nur lesend. Dieselben Regeln |
| `EBOOK_DIR` | `./ebooks` | Host-Pfad deines E-Book-Ordners, aufgebaut wie `AUDIOBOOK_DIR`, nur lesend. Dieselben Regeln |
| `TZ` | `Europe/Berlin` | Die Uhr, nach der die Statistik zählt. Ohne sie läuft der Container auf UTC, und jede Stunde, jeder Tag und jedes Jahr der Statistik verschiebt sich mit |
| `PORT` | `3000` | Host-Port, unter dem die App erreichbar ist |
| `SITE_NAME` | `Sonorus` | Name in Kopfzeile und Browser-Tab |
| `AUTH_USER` | `admin` | Benutzername für den ersten Administrator |
| `AUTH_PASSWORD` | *(leer)* | Gesetzt, um den ersten Administrator ohne Einrichtungsseite anzulegen |
| `AUTH_SECRET` | *(zufällig)* | Geheimnis zum Signieren der Sitzungs-Cookies; ohne Angabe wird ein stabiles zufälliges erzeugt und gespeichert |
| `TRUST_PROXY` | `1` | Reverse Proxies vor der App; auf `false` setzen, wenn sie direkt exponiert ist |
| `SCAN_ON_START` | `auto` | `auto` scannt nur bei leerer Bibliothek, `always` bei jedem Start, `never` gar nicht |

## Unterstützte Formate

Tags werden gelesen für MP3, M4A/AAC/ALAC, FLAC, OGG, Opus, WAV, AIFF, WMA, APE,
WavPack und Musepack; davon spielen aktuelle Firefox und Chromium MP3, M4A/AAC,
FLAC, OGG, Opus und WAV.

Standardmäßig streamt Sonorus die Originaldatei, die Wiedergabe hängt also davon
ab, was dein Browser dekodieren kann. Die Einstellung **Qualität** ist die andere
Möglichkeit: Sie liefert stattdessen eine Kopie mit Opus 128 kbps, die jeder
aktuelle Browser und die Android-App spielen, egal was die Quelle war.

Diese Kopie wird einmal mit ffmpeg gemacht und behalten, es wird also nichts
kodiert, während du auf den Anfang eines Songs wartest. Drei Regeln entscheiden,
was du tatsächlich bekommst:

- **Kleiner wird nur Verlustfreies.** FLAC, WAV, AIFF, ALAC, APE, WavPack und DSD
  werden neu kodiert, und dort verdient die Einstellung ihr Geld - ein
  FLAC-Album ist ungefähr dreimal so groß wie dasselbe Album in Opus.
- **Eine verlustbehaftete Datei wird nie neu kodiert.** MP3, AAC, Opus und Vorbis
  werden ausgeliefert, wie sie liegen, egal mit welcher Bitrate. ffmpeg geht die
  Leiter hinunter und nie seitwärts: Aus einer verlustbehafteten Datei eine andere
  zu machen kostet eine Generation Verlust an einer Datei, die ohnehin klein genug
  war. Eine 320-kbps-MP3 streamt also mit 320 kbps, auch wenn die kleinere
  Qualität gewählt ist.
- **Dir wird gesagt, welches von beidem passiert ist.** Die App zeigt unter der
  Transportleiste das Format, das wirklich gespielt wird, nicht das gewünschte.

Ob eine Datei verlustfrei ist, wird am Codec gelesen, nicht an der Endung: Ein
komprimiertes WAV und ein hybrides WavPack gelten als verlustbehaftet, und alles,
dessen Container gar kein solches Kennzeichen trägt (WMA, Musepack), ebenfalls -
die sichere Seite.

Ohne ffmpeg auf dem Server läuft die App genau wie vorher und liefert nur
Originale; die Einstellungen sagen das, statt eine Wahl anzubieten, die nicht
funktionieren kann. Das Docker-Image bringt ffmpeg mit, das betrifft also nur ein
nacktes `npm start`.

Die Kopien werden am Ende jedes **Bibliothek scannen** in einem Rutsch gemacht,
und der Fortschrittsbalken deckt diese Phase wie die anderen ab. Sie liegen in
einem eigenen Volume (`TRANSCODE_DIR`, `/app/transcodes`) statt neben der
Datenbank: Sie sind groß, in einem Backup wertlos, und jede von ihnen lässt sich
aus der Datei, aus der sie kam, wieder herstellen.

`TRANSCODE_MAX_GB` ist eine **Räumungsschwelle**, kein Budget: Nichts wird
abgelehnt, weil es darüber liegt, sondern die am längsten nicht benutzten Kopien
werden gelöscht, sobald der Ordner sie überschreitet. Standard 60. **Auf 0
gesetzt wird nie geräumt** - die richtige Antwort, wenn der Ordner auf einem
Volume mit Platz liegt und du lieber jede Kopie behältst, als sie vor der
nächsten langen Fahrt neu zu kodieren. Die Einstellungen zeigen, was der Ordner
hält und welches von beidem gilt.

## Daten und Sicherung

Dein Musikordner ist **nur lesend** eingehängt - Sonorus schreibt nie hinein. Nur
die Datenbank (Bibliotheksindex, Konten, Playlists, Bewertungen, Import-Hinweise)
und die extrahierten Cover liegen im Docker-Volume `sonorus-data` unter
`/app/data`. Sichere dieses Volume, um Playlists und Bewertungen zu behalten; die
Bibliothek selbst lässt sich jederzeit mit einem erneuten Scan aufbauen.

## Ohne Docker betreiben

```bash
npm install
MUSIC_DIR=/pfad/zur/musik npm start
```

Braucht Node 20 oder neuer. Datenbank und Cover werden nach `./data` geschrieben
(mit `DATA_DIR` änderbar), die neu kodierten Kopien ebenso (mit `TRANSCODE_DIR`).
Installiere `ffmpeg` und leg es in den `PATH` - oder zeig mit `FFMPEG_PATH`
darauf -, wenn du die kleinere Streaming-Qualität willst; ohne liefert die App
nur Originale.

## Lizenz

Apache License 2.0 - siehe [LICENSE](LICENSE).
