# motions/ ― ダンスモーション＋楽曲の配置場所

各曲を 1 フォルダにまとめ、その中に **モーション（.vmd）** と **音源（.mp3 等）** を置きます。

```
motions/
├── motions.json          ← 一覧マニフェスト（自動生成）
└── <曲名>/
    ├── dance.vmd         ← ダンスモーション
    └── music.mp3         ← 楽曲（.mp3 / .m4a / .aac / .ogg / .wav）
```

- ファイル名は任意ですが、フォルダ内の最初の `.vmd` と最初の音源が自動採用されます。
- 曲を追加・改名・削除したら、以下を実行して `motions.json` を再生成し、コミットします。

```
node tools/build-motions-manifest.mjs
```

GitHub Pages はディレクトリ一覧を返さないため、公開環境では `motions.json`（マニフェスト）が必須です。
