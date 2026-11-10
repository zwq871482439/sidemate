# Sidemate

Sidemate is a small helper on the Windows desktop: drop a few files on it, and it writes a document that follows your template, with sources noted as Word comments.

It sits at the top edge of the screen and shows nothing but a pair of eyes. There are no accounts and no server, and it collects no usage data. Your DeepSeek key is stored encrypted on this computer.

## What it does

- **Writes new documents from a template**: give it an old weekly report, summary, or report as a template plus a few source files, and it writes a new Word document that keeps the template's fonts, heading levels, and paragraph spacing.
- **Cites every source**: text taken from your material is marked in Word comments with the file and page it came from.
- **Writes well**: it ships with two skills, "writing" and "writing Word". Claims that are not in your material are not quietly written into the document; they are listed separately in its reply for you to confirm.
- **Leaves originals alone**: it copies your files into its own workspace before working, and finished files are placed in the "Sidemate Output" folder.

## Installing

1. Download `sidemate-setup-0.2.0.exe` from [Releases](https://github.com/zwq871482439/sidemate/releases) and run the installer. The installer is not signed, so when Windows warns you, click "More info" and then "Run anyway".
2. On first launch, paste your DeepSeek API key, click "Test it", and wait for the confirmation that it works.

You need your own DeepSeek API key: get one from the [DeepSeek platform](https://platform.deepseek.com/).

## Privacy

Sidemate has no accounts and no server, and it collects no usage data. Task content is only sent to the DeepSeek endpoint you chose. Your key is encrypted with the system key store (DPAPI on Windows) and kept on this computer; it is only placed in the background program's environment when a task starts. See [PRIVACY.md](PRIVACY.md) for details.

## License

The code in this repository is under the MIT license; see [LICENSE](LICENSE). The third-party components shipped with it and their licenses are listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

## Security

Please report security problems by email to hello@deskware.cn instead of opening a public issue. See [SECURITY.md](SECURITY.md).
