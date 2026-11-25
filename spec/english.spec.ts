// Every text is in English, with no code of an internal plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textOf, tracked } from './tracked.ts';

const WORDS = `spent[aeio] acces[aeio] accend\\w+ spegn\\w+ nessun[ao]? nulla niente applica(?:t[aeio]|zione)? salva(?:to|taggio)? annulla apri chiudi voc[ei] regol[ae] agenti chiede
 chiest\\w+ cartella progetti? progetto predefinit[aeio] elimina(?:to|re|zione)? conferma ritir\\w+ riepilogo riprova quest[aeio] quell[aeio] dell[aeo] degli dei del nell[aeo] nel
 che di il lo gli una sono è più già perché poi dopo subito restano valgono vale valid[ao] modific[aeh]\\w* scegli cambi(?:a|ato|ate|ata) fase pagina righe altezza
 elenco cerca nome percorso provenienza sconosciuto vuoto memoria connettore caricamento scheda scrivi? tocca bloccat[aeio] chat\\s+su non\\s+[a-z]+(?:a|o|e|i)\\b
 esecutore risorse compressori mia altra`.split(/\s+/);
const ITALIAN = new RegExp(`(?<![\\w])(?:${WORDS.join('|')})(?![\\w])|[àèéìòùÀÈÉÌÒÙ«»]`, 'gi');
const PLAN = /\b(?:[ABCDFIMNSTV]\d{1,2})\b|§|PIANO/g;

test('no Italian and no plan code in any file', () => {
  const hits = tracked.filter((f) => f !== 'spec/english.spec.ts').flatMap((f) => textOf(f).split('\n').flatMap((line, n) =>
    [...line.matchAll(ITALIAN), ...line.matchAll(PLAN)].map((m) => `${f}:${n + 1}: ${m[0]}`)));
  assert.deepEqual(hits, [], `${hits.length} found`);
});
