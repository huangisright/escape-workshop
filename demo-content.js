// platform/demo-content.js
// 示範模式用的範例關卡（還沒接上 Google 試算表時使用）。
// 正式示範時，題目來自老師們的出題試算表，不會用到這個檔案。

window.DEMO_CONTENT = {
  id: 'demo',
  title: '黃金城密室：氣候變遷（範例）',
  settings: { timeLimitMin: 90, skipPenaltyMin: 5 },
  prologue:
    '傳說中的黃金城，因為海水一年年上漲，沉進了海底。\n' +
    '你們是第一支找到城門的探險隊。城裡五座塔各藏著一塊大門碎片，\n' +
    '集齊五塊，才能打開黃金城的大門。\n\n' +
    '（這是範例關卡，用來試玩平台。正式題目由老師們出。）',
  main: [
    {
      id: 'demo-1', type: '數字', estMin: 14, difficulty: '易',
      story:
        '【空氣塔】塔裡的記錄器只剩一張紙條：\n\n' +
        '「工業革命以前，空氣中的二氧化碳大約是 ___ ppm。\n' +
        '　2015 年的《巴黎協定》，希望把升溫控制在 1.5°C 以內。」\n\n' +
        '把空格的數字和 1.5 接在一起（去掉小數點），就是密碼。',
      image: '',
      answer: '28015',
      hint: '空格是三位數，開頭是 2；後面接上 15。',
      success: '記錄器亮了起來，吐出第一塊碎片。',
      fragment: '7', transition: ''
    },
    {
      id: 'demo-2', type: '方向', estMin: 14, difficulty: '中',
      story:
        '【潮汐塔】地上的石板被海水淹了一半，只看得到一行字：\n\n' +
        '「北行二，東行一，南行一。」\n\n' +
        '地圖上北方朝上。照著石板走，按出你們的路線。',
      image: '',
      answer: '上上右下|↑↑→↓',
      hint: '北＝上、東＝右、南＝下。「北行二」要按兩次。',
      success: '最後一塊石板沉下去，牆上的暗格打開了。',
      fragment: '3', transition: '你們沿著退潮的走廊，來到下一座塔。'
    },
    {
      id: 'demo-3', type: '顏色', estMin: 14, difficulty: '中',
      story:
        '【溫度塔】牆上有一幅「暖化條紋」：每一條代表一年的平均氣溫，\n' +
        '比長期平均冷的年份畫成藍色，接近平均的是白色，比平均熱的是紅色。\n\n' +
        '門鎖要你們依照「從過去到現在」的順序，按出條紋大致的顏色變化（三個顏色）。',
      image: '',
      answer: '藍白紅',
      hint: '過去比較冷，現在比較熱。',
      success: '條紋一條條亮起，第三塊碎片從牆裡滑出來。',
      fragment: '1', transition: ''
    },
    {
      id: 'demo-4', type: '文字', estMin: 14, difficulty: '易',
      story:
        '【能源塔】塔頂的風車旁刻著一則謎語：\n\n' +
        '「太陽給我光，風給我力，流水讓我轉；\n' +
        '　我用了還會再來，取之不盡。」\n\n' +
        '我是哪一類能源？（四個字）',
      image: '',
      answer: '再生能源|可再生能源',
      hint: '「用了還會再來」，就是可以「再生」。',
      success: '風車轉了起來，第四塊碎片掉進你們手裡。',
      fragment: '9', transition: ''
    },
    {
      id: 'demo-5', type: '數字', estMin: 14, difficulty: '難',
      story:
        '【冰山塔】塔前漂著一座冰山。冰的密度大約是海水的九成，\n' +
        '所以一座冰山大約只有一成露出水面，九成藏在水面下。\n\n' +
        '如果露出水面的部分是 5000 立方公尺，\n' +
        '水面下大約是多少立方公尺？',
      image: '',
      answer: '45000',
      hint: '水面上是一份，水面下是九份。',
      success: '冰山轉了個身，露出最後一塊碎片。',
      fragment: '4', transition: ''
    }
  ],
  finale: {
    story:
      '【黃金城大門】五塊碎片拼回大門上，門上浮現五個空格。\n\n' +
      '打開線索簿，把五塊碎片「依照拿到的順序」輸入。',
    type: '數字',
    answer: '',
    estMin: 10,
    hint: '線索簿上的數字，從第一塊讀到第五塊。',
    success: '大門緩緩打開，你們逃出來了！\n還有時間的話，城裡的寶庫正等著你們。'
  },
  vault: [
    {
      id: 'demo-v1', type: '數字', estMin: 5, difficulty: '易',
      story: '【寶庫・一】地球表面大約有百分之幾被海洋覆蓋？（輸入整數）',
      image: '', answer: '71|70', hint: '超過三分之二。',
      success: '你們拿到一顆藍色寶石。'
    },
    {
      id: 'demo-v2', type: '文字', estMin: 8, difficulty: '中',
      story: '【寶庫・二】牛在消化草的時候，會打嗝放出一種很強的溫室氣體。是哪一種？',
      image: '', answer: '甲烷|ch4', hint: '天然氣的主要成分。',
      success: '你們拿到一頂金色頭冠。'
    },
    {
      id: 'demo-v3', type: '數字', estMin: 10, difficulty: '難',
      story:
        '【寶庫・三】如果一座城市每年把碳排放減少 7%，\n' +
        '大約幾年後，排放量會剩下原來的一半？（輸入整數）',
      image: '', answer: '10', hint: '試試「72 法則」：72 ÷ 每年的百分比。',
      success: '你們拿到黃金城的權杖！'
    }
  ]
};
