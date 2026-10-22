# Story framework catalog

`catalog.yaml` is read-only planning data shipped inside the Tsugite v2 package.
`plugin story consult` reads this file. It does not search parent directories.

この `catalog.yaml` は、リポジトリの `knowledge/story-frameworks/catalog.yaml` と同じバイトです。
物語相談はこの同梱ファイルだけを読みます。引用先の本文は同梱していません。
`source_ids` が空の項目は、出典がない記録のままです。空欄を出典ありとは扱いません。

The file is covered by the MIT license at the end of this notice.
Cited pages are not reproduced. Entries record structural roles and point at those pages.
An empty `source_ids` list means the catalog recorded no citation for that item.

## Sources

- save-the-cat: What Is the Save the Cat Method? (Save the Cat) https://savethecat.com/get-started accessed 2026-07-11
- screen-direction: What is the 180 Degree Rule in Film? (StudioBinder) https://www.studiobinder.com/blog/what-is-the-180-degree-rule-film/ accessed 2026-07-11
- continuity-editing: What is Continuity Editing in Film? (StudioBinder) https://www.studiobinder.com/blog/what-is-continuity-editing-in-film/ accessed 2026-07-11
- split-edits: Perform J cuts and L cuts (Adobe) https://helpx.adobe.com/ca/premiere/desktop/edit-projects/trim-clips/perform-j-cuts-and-l-cuts.html accessed 2026-07-11
- visual-composition: Cinematography basics, elements and techniques (Adobe) https://www.adobe.com/uk/creativecloud/video/production/cinematography.html accessed 2026-07-11
- rule-of-thirds: How to use and break the rule of thirds (Adobe) https://www.adobe.com/au/creativecloud/photography/discover/rule-of-thirds.html accessed 2026-07-11
- copywriting-formulas: My Go-To Copywriting Templates (HubSpot) https://blog.hubspot.com/marketing/copywriting-templates accessed 2026-07-11
- documentary-guide: My American Story Storytelling Guide (PBS WETA) https://www.pbs.org/weta/iconic-america/wp-content/uploads/2024/01/Iconic-America-Storytelling-Guide.pdf accessed 2026-07-11
- music-video-types: Five main types of music videos (Wedio) https://www.wedio.com/en/learn/types-of-music-videos accessed 2026-07-11
- comedy-rule-three: The Rule of Three in Comedy (ScreenWeaver) https://www.screenweaver.ai/blog/rule-three-comedy-setup-reinforce-subvert accessed 2026-07-11

## License

MIT License

Copyright (c) 2026 Takamasa Ito

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
