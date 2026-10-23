/**
 * 星问题库。每条答案都能在 `data.ts` 里找到出处 —— 出题不靠编，
 * 答错时给的解释也直接引用卡片上的真实数字。
 */
export type Question = {
  id: string;
  prompt: string;
  options: string[];
  answer: number; // options 下标
  note: string;
};

export const QUESTIONS: Question[] = [
  {
    id: "sun-mass",
    prompt: "太阳的质量约占整个太阳系的多少？",
    options: ["50%", "86%", "99.86%", "99.999%"],
    answer: 2,
    note: "99.86%。剩下所有行星、卫星、小行星加起来不到千分之二。",
  },
  {
    id: "fastest-orbit",
    prompt: "公转周期最短、跑得最快的行星是？",
    options: ["水星", "金星", "地球", "火星"],
    answer: 0,
    note: "水星只要 88 个地球日，比金星（225 日）快一倍多。",
  },
  {
    id: "hottest",
    prompt: "哪颗行星的表面温度比水星还高？",
    options: ["火星", "金星", "木星", "海王星"],
    answer: 1,
    note: "金星约 460°C。靠的不是离太阳近，而是浓厚的二氧化碳大气造成的失控温室。",
  },
  {
    id: "biggest-moon",
    prompt: "太阳系里直径最大的卫星是？",
    options: ["月球", "木卫三", "土卫六", "木卫四"],
    answer: 1,
    note: "木卫三 5,268 公里，比水星（4,879 公里）还大，而且是唯一有自己磁场的卫星。",
  },
  {
    id: "titan-lakes",
    prompt: "哪颗卫星表面有液态甲烷和乙烷构成的湖泊？",
    options: ["土卫六", "木卫二", "木卫一", "月球"],
    answer: 0,
    note: "土卫六，浓氮大气 + 甲烷湖泊，是太阳系里唯一有稳定液体循环的卫星。",
  },
  {
    id: "uranus-tilt",
    prompt: "哪颗行星的自转轴几乎倒在轨道面上，像侧躺着滚动？",
    options: ["海王星", "土星", "天王星", "金星"],
    answer: 2,
    note: "天王星自转轴倾角约 97.8°，所以它的环也近乎竖直。",
  },
  {
    id: "great-red-spot",
    prompt: "木星大红斑本质上是？",
    options: ["一座超级火山", "持续数百年的反气旋风暴", "撞击坑", "冰层裂缝"],
    answer: 1,
    note: "一场持续数百年的反气旋风暴，比整个地球还宽。",
  },
  {
    id: "neptune-period",
    prompt: "公转周期约 165 年的行星是？",
    options: ["天王星", "土星", "海王星", "木星"],
    answer: 2,
    note: "海王星绕太阳一圈要 165 年 —— 从 1846 年被发现到现在，它才走完一圈多一点。",
  },
  {
    id: "moon-gravity",
    prompt: "月球表面的引力大约是地球的？",
    options: ["1/2", "1/3", "1/6", "1/10"],
    answer: 2,
    note: "1/6。所以登月宇航员穿着厚重宇航服还能一蹦老高。",
  },
  {
    id: "jupiter-moons",
    prompt: "已知卫星数量超过 95 颗的行星是？",
    options: ["土星", "木星", "天王星", "海王星"],
    answer: 1,
    note: "木星 95 颗以上，土星 140 颗以上 —— 两颗巨行星的卫星就占了太阳系绝大多数。",
  },
  {
    id: "mars-distance",
    prompt: "距太阳约 1.52 AU 的行星是？",
    options: ["金星", "地球", "火星", "木星"],
    answer: 2,
    note: "火星 1.52 AU，公转 687 个地球日。",
  },
  {
    id: "retrograde",
    prompt: "哪颗行星的自转方向与多数行星相反？",
    options: ["水星", "金星", "天王星", "火星"],
    answer: 1,
    note: "金星。它的自转轴倾角接近 177°，等于是倒过来转的。",
  },
  {
    id: "europa-ocean",
    prompt: "冰壳之下可能存在全球性海洋的卫星是？",
    options: ["木卫一", "木卫二", "木卫四", "月球"],
    answer: 1,
    note: "木卫二（欧罗巴），表面光滑、裂缝纵横，冰下可能有比地球总量还多的液态水。",
  },
  {
    id: "sun-surface",
    prompt: "太阳表面的温度约为？",
    options: ["约 1,500 °C", "约 5,500 °C", "约 15,000 °C", "约 150,000 °C"],
    answer: 1,
    note: "约 5,500 °C。注意这只是表面，核心温度超过 1,500 万 °C。",
  },
  {
    id: "saturn-rings",
    prompt: "土星环主要由什么组成？",
    options: ["液态气体", "冰与岩石碎块", "尘埃与二氧化碳", "金属微粒"],
    answer: 1,
    note: "冰与岩石碎块。环很宽，但厚度往往只有几十米。",
  },
  {
    id: "io-volcano",
    prompt: "太阳系里火山活动最剧烈的天体是？",
    options: ["木卫一", "火星", "金星", "海王星"],
    answer: 0,
    note: "木卫一（伊俄），被木星的潮汐揉搓加热，表面布满活火山。",
  },
];

/** 随机抽 n 题，题干与选项顺序都打乱 */
export function drawRound(n: number): Question[] {
  const pool = [...QUESTIONS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n).map((q) => {
    const order = q.options.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    return {
      ...q,
      options: order.map((i) => q.options[i]!),
      answer: order.indexOf(q.answer),
    };
  });
}
