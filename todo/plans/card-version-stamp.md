# Give the card a version stamp that can be found in one read

## What is wrong today

Studio can ask a card over USB which firmware version it is carrying. The way it
asks is to read the card's whole program area — a little over two megabytes down
a serial cable — hunting for the version number and build id written next to each
other somewhere inside it.

Two things are wrong with that.

**It cannot succeed.** The compiler stopped placing those two strings next to
each other around release 1.1.4. Every signed image from 1.1.4 to 1.1.28 has no
findable stamp; only 1.0.0 through 1.1.3 do. Checked by scanning every signed
image kept in the repository. A bench build is worse still: it stamps itself
`dev`, three characters where the reader demands a forty-character build id, so
it could never match at all.

**It is slow enough to look broken.** Because the search never matches, it runs
to the end of the program area every single time — thirty to ninety seconds of a
button that says it is working and shows nothing. That is what made "Find
connected card" appear stuck on 21 August 2026.

The slowness is already fixed on the Studio side: the version read now runs in
the background after the card is found, reports its progress, gives up after
twenty-five seconds, and never blocks connecting or installing. What is left is
making the stamp findable again, and making sure it cannot rot away unnoticed a
second time.

## What is missing that this fixes

While no stamp can be read over USB, Studio cannot tell that a card plugged in by
cable is already carrying Lightweaver. That is the fact that decides whether the
screen offers **the update that keeps the card's Wi-Fi, project, patterns and
settings**, or only the destructive erase-and-install. So today a USB card is
always offered the destructive path. This is not a cosmetic fix.

## The work

1. **Put the stamp at a fixed, known place.** Every ESP32 program image already
   carries a description block thirty-two bytes in from the start, holding a
   version string the build sets. Lightweaver does not set it, so the card
   currently reports the stock toolchain string (`esp-idf: v4.4.7`) instead of
   its own version. Set it to the firmware version and build id. One four-kilobyte
   read then answers the question, instead of a two-megabyte search.
2. **Read the fixed place first.** Keep the old search as a fallback so cards
   already in the world that carry an old-style stamp still identify themselves,
   and so the 1.0.0–1.1.3 images keep working. Bounded exactly as it is now.
3. **Make it impossible to rot again.** Add a check to the build that fails when
   a compiled image carries no readable stamp. This is the part that matters
   most: it is what would have caught this twenty-four releases ago.
4. **Confirm the preserving update path comes back.** With a stamp readable over
   USB, a card plugged in by cable should once again be offered the update that
   keeps its settings, not only the erase-and-install.

## How to know it is done

- A freshly built bench image reports its own version and build id from the
  fixed place, read in one go rather than searched for.
- Every signed image in the repository from 1.0.0 onward still identifies
  itself, old-style ones through the fallback.
- The new build check fails when the stamp is removed on purpose, and passes
  otherwise.
- A real card on USB is offered the settings-preserving update.

## Why this needs a card release

This changes what is compiled into the card, so it needs a version bump and a
signed release to reach a card in someone's home. That is the whole cost of the
item, and the reason it was not folded into the Studio-side fix.
