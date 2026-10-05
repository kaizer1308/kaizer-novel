# Kaizer

Kaizer writes full-length light novels and web novels on autopilot. Give it a premise and it builds a story bible, plans the arcs, then writes the chapters one by one. Before writing the next chapter, it checks each one against canon and saves what happened.

It runs on your own ChatGPT plan through OpenAI's [Sign in with ChatGPT](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt). Books and story memory stay on your computer in `data/kaizer.db`.

## Run it

Requires Node.js 24 or newer.

```sh
npm install
npm run build
npm start          # http://127.0.0.1:4317
```

For development (server and Vite with hot reload), run `npm run dev` and open http://127.0.0.1:5173.

Use `127.0.0.1`, not `localhost`. Sign in with ChatGPT only redirects back to loopback IP addresses.

## How it keeps a long book consistent

Each chapter is written from a context packet that fits a fixed token budget. Kaizer does not send the whole manuscript. The packet contains:

- **Story bible:** the world, the hard rules, the power system, and a glossary.
- **Cast cards:** a profile for every character, place, or item in the chapter, plus its *current state*. That includes anyone the chapter's plan or text names, not only the planned cast. The state covers location, condition, level, possessions, relationships, and what that character knows. It is carried forward chapter to chapter, so lasting details are kept. When the story settles something the profile got wrong, a correction is added to the profile.
- **Every other name in the book, with its role:** so a new minor character is never given a name someone already has.
- **Story so far:** synopses of finished arcs, summaries of the current arc and the last dozen chapters, and detailed recaps of the last three chapters.
- **Canon facts:** retrieved with full-text search on the chapter's cast and beats.
- **Open plot threads:** unresolved setups waiting for a payoff.
- **The final passage of the previous chapter:** for voice and scene continuity.
- **The next chapter's plan:** so this chapter stops at its hook instead of playing out what comes next.

After each chapter, a continuity pass checks it against the bible's rules, the cast cards, the facts, and its own numbers and timeline. It also looks for a scene the previous chapter already showed, a passage repeated word for word, and anything the next chapter is planned to do. Problems are fixed by editing only the passages at fault, up to twice. Whatever is still wrong after that is repaired before the next chapter is written. Each chapter's end records the in-story day and time, so the calendar does not drift. Arcs are planned one at a time, as each begins, so the outline follows what was actually written. The planner is told what earlier chapters already showed, so no scene is staged twice. The final arc is planned to pay off every open thread.

## Changing the book while it writes

The book is yours to steer. In the box under the chapter, say what you want changed: *make Rin refuse the offer*, *call her Mira instead*, *drop the tournament and go straight to the war*, *less romance from here on*, *give this arc five more chapters*. Or highlight a passage in any chapter, including the one being written, choose **Change this**, and say what it should become. Both work in the reader too, and on a touch screen.

A request is taken up at once: whatever autopilot is writing is dropped and written again afterwards, from the changed plan. Two things come first: a request about the chapter being written waits for that draft to land, and edits or repairs already queued are finished before the next request is read. Then autopilot carries on to the last chapter. One pass turns the request into changes that keep the story in one piece:

- **What is not written yet** changes in the plan: the story bible, the remaining arcs, the planned chapters, and each character's profile and current state.
- **What is already written** is edited passage by passage, the same way the proofreader repairs a chapter, so the rest stays word for word. Later chapters the change would contradict are edited too, and each edited chapter's recap and canon facts are read again from its new text.
- **A rename** is applied everywhere at once, written and planned, in every form the name takes. The full name is replaced, also where it is set in capitals. A part of it used alone, such as a first name, is replaced too when nothing else in the book carries it. A part that is shared, like a surname a relative keeps, or that is also an ordinary word, is not replaced blind: see the next point.
- **Everything written is checked against the change.** The pass that plans a change sees most chapters only as summaries, so what may still tell the old version is found for it, three ways. A part of a replaced name, exactly as the text spells it. A word the change touches, in any of its forms: *key* also finds *keys*. And, when the change alters something true of a character or a thing, every chapter they are in or spoken of, because the prose there may say only *she* or *the nurse*. The model then reads what was found: whole chapters where the change is about someone in them, otherwise just the passages that use the word, with the paragraphs around them. Its corrections land as passage edits, and the story's own records (recaps, facts, character states, plans, the bible) are corrected the same way, since those feed every later chapter. You are not expected to find leftovers yourself.
- **A lasting wish** about tone, pacing, or style becomes a standing direction for every chapter that follows.
- **The book's length** changes an arc at a time: an unfinished arc gets more or fewer chapters and its unwritten ones are planned again, an arc nothing was written for can be cut, and a new arc can be added at the end, to a finished book as well.

The request box answers too: ask what happens to a character or why a scene went the way it did, and it answers from the canon without changing anything; if a request could be read two ways, it asks which you mean first. It knows which chapter is on your screen, so *this chapter* means that one. Under each reply is a list of what the change really did to the canon and the plan, and the chapters it edited.

An edited chapter shows what changed, in place: text that came is highlighted, text that went is struck through. The marks stay, through later edits too, until you dismiss them.

**Edit by hand** under a written chapter opens its text for you to rewrite. Your text is saved as it is, and the same pass then brings the canon, the plan, and any chapter it now contradicts in line with it. Text you have changed is yours: the continuity pass reads it but never rewrites it, findings the proofreader had about the text it replaced are dropped, and the chapter is audited afresh. A drafted next chapter that was built on the old text is written again.

Every change can be undone. **Undo** puts the whole book back to the moment before that change, so later changes and chapters written since go with it, and autopilot writes those chapters again. The last ten changes of a book can be undone.

A paused book carries out a request without resuming, a finished one reopens for it, and a request that has not been started can be withdrawn. When the book is done, the proofreader checks the edited chapters against the whole story like any others.

## The proofreader

When the last chapter is done, the whole book is re-read in windows of consecutive chapters, each checked against the full story: contradictions, timeline breaks, setups without payoffs, broken text. Flagged chapters are repaired by editing only the passages at fault: the model returns each passage with its replacement, and an edit is applied only when that passage is found exactly once, so the rest of the chapter stays word for word. If the edits cannot be placed, the chapter is rewritten instead. Three windows are read at once, but their findings land in order, as if read one after another: once a window has something to repair, the readings of the windows after it are set aside and made again after the repairs, so no window is repaired from a reading that an earlier repair has made stale. Repairs run up to three at once too, but only for chapters at least four apart that no finding ties together (a finding is tied to every chapter it names); tied repairs go one after the other, and the second checks whether the first already settled its problem. Changes you asked for go one at a time. A repair that changes nothing, or would gut, bloat, or repeat the chapter, is refused. A repaired chapter has its recap and canon facts read again from the new text, its arc's synopsis is written again, and it is checked once more, up to its third repair. A last pass judges every open plot thread and the ending, and repairs the holes. Nitpicks are repaired too, except in a chapter you edited by hand, where they wait for you. The report shows what was repaired and what could not be. **Repair these too** sends nitpicks still waiting through the same repair. **Proofread again** runs the whole pass once more whenever you like, from scratch, on any book whose last chapter is written; its report replaces the last one. The proofreader can use its own model and reasoning level (**Proofreading** in the book's stats panel); chapters are still written with the book's model.

A ChatGPT sign-in lasts one hour and is meant to renew itself. When ChatGPT refuses the renewal, Kaizer keeps writing until the hour is up, shows a **Renew sign-in** prompt, and otherwise holds the book until you sign in again, then resumes it without being asked.

Every step is saved before the next one starts. If you close the tab, restart the server, or hit a ChatGPT usage limit, autopilot resumes where it left off.

## Publishing to Webnovel Inkstone

The **Inkstone** button on a book uploads its chapters to a novel on [Inkstone](https://inkstone.webnovel.com), Webnovel's author dashboard.

1. **Connect.** Inkstone has no sign-in for other apps, so Kaizer uses your browser session: sign in to Inkstone, copy the `cookie` request header from the browser's Network tab, and paste it in. It is stored in `data/kaizer.db`; whoever holds it can act as you on Webnovel.
2. **Link.** Create the novel on Inkstone once (title, genre, cover), then pick it in Kaizer.
3. **Publish.** Select chapters and upload them as drafts, publish them now, schedule them (a first date, then one every N hours), or remove them again. Selecting every chapter of a finished book imports the whole book.

A book can also do this by itself as each chapter is finished: upload a draft, publish right away, or publish on a release schedule. If the proofreader rewrites a chapter afterwards, its copy on Inkstone is updated too, whether it is a draft, scheduled, or already published. You can see that it was: an edited chapter says *Updating on Inkstone…*, then *Updated on Inkstone* with the time, or that Inkstone refused it; the Inkstone panel shows the same per chapter, and the proofreading report says whether Inkstone has the repaired text of every repaired chapter. Readers who got to a published chapter before the proofreader did have read the earlier text, so for a book that is still being written, a schedule that trails the writing is safer than publishing right away.

Chapters go up in order, about one every two seconds. Everything queued is saved, so a restart or an expired session only delays it: Kaizer asks for a new cookie and carries on. A schedule further ahead than Inkstone accepts waits as a draft, and Kaizer sets the timer once the date is within reach; that last step needs Kaizer running.

This uses the same private endpoints as Inkstone's own web app, not a published API, so a change on Webnovel's side can break it. Webnovel's rules on automation and on AI-written work apply to what you publish.

## Tests

```sh
npm test
```
