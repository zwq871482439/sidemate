# Sidemate 0.2.0

Sidemate sits at the top of your screen and shows nothing but a pair of eyes. Drop a template and some source material on it, tell it what to write, and it produces a new document that follows your template. Your originals are never modified.

This is the first version of Sidemate published here. It runs on Windows only and needs your own DeepSeek API key.

## What it does

- **Writes new documents from a template**: give it an old weekly report, summary, or report as a template plus a few source files, and it writes a new Word document that keeps the template's fonts, heading levels, and paragraph spacing.
- **Cites every source**: text taken from your material is marked in Word comments with the file and page it came from. When you ask it to expand or polish a single draft, no comments are added and the original formatting is kept.
- **Writes well**: it ships with two skills, "writing" and "writing Word". It decides the document type, lays out an outline, writes section by section, and finally re-reads the draft from the reader's point of view. Claims that are not in your material (people, deadlines, targets, confidentiality, and the like) are not quietly written into the document; they are listed separately in its reply for you to confirm.
- **Leaves originals alone**: it copies your files into its own workspace before working. Finished files are placed in the "Sidemate Output" folder.

## How to use it

- The island sticks to the top edge of the screen and can be dragged left or right. Hovering over it shows a short line of text. Its eyes change with what it is doing: looking down at the draft while working, smiling eyes when it is done, wide eyes with a red dot when it has something to tell you.
- Click the island and the task window drops down beneath it. Click again to fold it away; the work keeps going.
- You can drop files onto the island or into the task window: on the left they are templates, on the right they are source material.
- The settings page shows how much you have used this month, and how much each of the last 10 tasks used. The numbers match your DeepSeek dashboard.
- Right-click the island to keep it in front of other windows. When a full-screen presentation is playing or you are watching a video, the island folds into a thin line.

## Installing

1. Download `sidemate-setup-0.2.0.exe` below and run the installer. The installer is not signed, so when Windows warns you, click "More info" and then "Run anyway".
2. On first launch, paste your DeepSeek API key, click "Test it", and wait for the confirmation that it works.

## Known issues

- It has only been tested on Windows 10 and 11. Multiple monitors have not yet been tried on real hardware.
- Web searches are counted separately and are not counted towards your usage, so the usage shown in the settings is slightly lower than your DeepSeek dashboard.

## Privacy

Sidemate needs no account and has no server of ours. Your key is stored encrypted on this computer, and task content is sent by the program directly to DeepSeek. See [PRIVACY.md](../PRIVACY.md) for details.
