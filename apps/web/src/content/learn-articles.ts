/**
 * FTL Learn articles, in Somali.
 *
 * Each article answers one question Somali speakers actually type into a
 * search box ("waa maxay crypto", "USDT iyo USDC", ...), so each gets its own
 * URL, title and description, and ships Article + FAQ structured data.
 *
 * Plain data on purpose: the middleware (edge runtime) reads the slugs to route
 * learn.ftlexchange.com/<slug>, the sitemap lists them, and the article page
 * renders them. Nothing here promises returns or gives financial advice.
 */

export interface LearnArticle {
  slug: string;
  /** Page title: the question, the way it is searched. */
  title: string;
  /** Meta description, under ~155 characters. */
  description: string;
  keywords: string[];
  intro: string;
  sections: { heading: string; body: string[] }[];
  faq: { q: string; a: string }[];
  /** ISO date, for Article structured data and the sitemap. */
  updated: string;
}

export const LEARN_ARTICLES: LearnArticle[] = [
  {
    slug: "waa-maxay-crypto",
    title: "Waa maxay crypto? Lacagta dijitaalka ah oo si fudud loo sharraxay",
    description:
      "Crypto waa lacag dijitaal ah oo ku diiwaangashan blockchain. Baro sida ay u shaqeyso, faa'iidooyinkeeda iyo khatarteeda, af-Soomaali fudud.",
    keywords: ["crypto", "waa maxay crypto", "lacag dijitaal ah", "cryptocurrency af soomaali", "blockchain"],
    intro:
      "Crypto (cryptocurrency) waa lacag dijitaal ah oo aan lahayn warqad ama qadaadiic. Waxay ku jirtaa diiwaan la wadaago oo loo yaqaan blockchain, oo ay hayaan kumanaan kombiyuutar oo adduunka ku kala firirsan.",
    sections: [
      {
        heading: "Sidee buu crypto u shaqeeyaa?",
        body: [
          "Marka aad crypto u dirto qof, fariin saxiixan ayaa loo diraa shabakadda. Kombiyuutarrada shabakaddu waxay hubiyaan in saxiixu sax yahay oo haraagu jiro, kadibna wareejinta waxay gashaa block cusub oo ku xiran kuwii hore.",
          "Sababtoo ah block kasta wuxuu sitaa faraha (hash) kii ka horreeyay, beddelka diiwaan hore wuxuu jebinayaa silsiladda oo dhan. Taasaa ka dhigaysa blockchain mid adag in la khiyaameeyo.",
        ],
      },
      {
        heading: "Noocyada ugu caansan",
        body: [
          "Bitcoin (BTC) waa crypto-gii ugu horreeyay, oo tiradiisu go'an tahay. Ethereum (ETH) waa shabakad lagu dhiso barnaamijyo. Stablecoins sida USDT iyo USDC waxaa loo sameeyay inay la socdaan doollarka Maraykanka.",
        ],
      },
      {
        heading: "Khatarta la ogaado",
        body: [
          "Qiimaha crypto aad buu isu beddelaa: maalin kor u kaca, maalinta xigta hoos u dhaca. Wareejin la diray lama celin karo. Khiyaanooleyaal badan ayaa isticmaala magaca crypto si ay dadka lacagtooda uga qaataan.",
          "Weligaa ha galin lacag aadan awoodin inaad lumiso, weligaana ha la wadaagin furahaaga sirta ah ama weedhaada soo celinta.",
        ],
      },
    ],
    faq: [
      {
        q: "Crypto ma lacag dhab ah baa?",
        a: "Crypto waa hanti dijitaal ah oo la iibsan karo oo la iibin karo, laakiin dowladdu ma bixiso sida shilinka ama doollarka. Qiimaheedu wuxuu ku xiran yahay suuqa.",
      },
      {
        q: "Crypto ma lagu ilaalin karaa?",
        a: "Haa. Waxaad ku haysan kartaa boorso aad adigu furaha u haysato, ama shirkad kuu haysa. Labadaba waxay leeyihiin khatar u gaar ah.",
      },
      {
        q: "Crypto ma halis baa?",
        a: "Haa. Qiimuhu si xoog leh ayuu isu beddelaa, khiyaanaduna way badan tahay. Baro ka hor intaadan wax gelin.",
      },
    ],
    updated: "2026-09-19",
  },
  {
    slug: "waa-maxay-bitcoin",
    title: "Waa maxay Bitcoin (BTC)? Sharraxaad af-Soomaali ah",
    description:
      "Bitcoin waa crypto-gii ugu horreeyay. Baro cidda samaysay, sababta tiradiisu u go'an tahay, sida loo haysto iyo khatarta ku jirta.",
    keywords: ["bitcoin", "waa maxay bitcoin", "BTC", "bitcoin af soomaali", "bitcoin soomaaliya"],
    intro:
      "Bitcoin waa lacagta dijitaalka ah ee ugu horreysay, oo la bilaabay 2009 qof isku magacaabay Satoshi Nakamoto. Bitcoin kama madaxbannaana bangi ama dowlad: waxaa hayo shabakad kombiyuutarro ah.",
    sections: [
      {
        heading: "Maxaa Bitcoin ka dhigaya mid gaar ah?",
        body: [
          "Weligood 21 milyan oo Bitcoin ka badan lama sameyn doono. Tiradan go'an ayaa ah sababta dad badan ugu arkaan Bitcoin sida dahab dijitaal ah.",
          "Wareejin kasta waxay ku diiwaangashan tahay blockchain-ka Bitcoin, oo qof walba arki karo.",
        ],
      },
      {
        heading: "Sidee Bitcoin loo haystaa?",
        body: [
          "Bitcoin waxaa lagu hayaa boorso (wallet). Boorsadu ma hayso Bitcoin-ka laftiisa: waxay haysaa furaha sirta ah ee caddeeya inuu kuu gaar yahay. Qofkii haysta furahaas ayaa maamula Bitcoin-ka.",
        ],
      },
      {
        heading: "Qiimaha Bitcoin",
        body: [
          "Qiimaha Bitcoin wuxuu go'aamiyaa iibsadayaasha iyo iibiyayaasha suuqa. Wuxuu isu beddeli karaa boqolkiiba tobanaan todobaad gudihiis, sidaas darteed waa hanti khatar badan.",
        ],
      },
    ],
    faq: [
      {
        q: "Bitcoin yaa sameeyay?",
        a: "Qof ama koox isku magacaabay Satoshi Nakamoto, 2008-2009. Aqoonsiga dhabta ah weli lama oga.",
      },
      {
        q: "Ma iibsan karaa qayb Bitcoin ah?",
        a: "Haa. Bitcoin wuxuu u qaybsamaa ilaa 100 milyan qaybood (satoshi), sidaas darteed looma baahna in la iibsado mid dhan.",
      },
      {
        q: "Bitcoin ma la jabsan karaa?",
        a: "Shabakadda Bitcoin lafteedu aad bay u adag tahay, laakiin boorsooyinka iyo akoonnada dadka waa la jabsan karaa haddii furayaasha si xun loo ilaaliyo.",
      },
    ],
    updated: "2026-09-19",
  },
  {
    slug: "usdt-iyo-usdc",
    title: "USDT iyo USDC: Waa maxay stablecoin, maxayse ku kala duwan yihiin?",
    description:
      "USDT iyo USDC waa stablecoins la socda doollarka. Baro sida ay u shaqeeyaan, farqiga u dhexeeya, iyo waxa la ogaado ka hor intaadan isticmaalin.",
    keywords: ["USDT", "USDC", "stablecoin", "tether", "usdt af soomaali", "doollar dijitaal ah"],
    intro:
      "Stablecoin waa crypto loogu talagalay inuu qiimihiisu la mid ahaado lacag caadi ah, badanaa doollarka Maraykanka. USDT (Tether) iyo USDC (USD Coin) waa labada ugu caansan.",
    sections: [
      {
        heading: "Sidee buu stablecoin u ilaaliyaa qiimihiisa?",
        body: [
          "Shirkadda soo saarta ayaa sheegta inay haysato kayd (doollar ama hanti la mid ah) oo u dhiganta coin kasta. Haddii aad hal USDC haysato, waxaa loogu talagalay inuu hal doollar u dhigmo.",
        ],
      },
      {
        heading: "USDT iyo USDC ku kala duwan",
        body: [
          "USDT waxaa soo saara shirkadda Tether, waana stablecoin-ka ugu isticmaalka badan. USDC waxaa soo saara Circle, waxayna si joogto ah u daabacdaa warbixinno kaydadkeeda ku saabsan.",
          "Labaduba waxay ku jiraan shabakado badan (Ethereum, Base, Tron, Solana). Markaad dirayso, hubi inaad isticmaalayso shabakadda uu qaatahu rabo.",
        ],
      },
      {
        heading: "Khatarta stablecoin",
        body: [
          "Stablecoin-ku wuxuu ku tiirsan yahay kalsoonida shirkadda soo saarta. Haddii kaydadku ka yaraadaan, qiimuhu wuu ka dhici karaa hal doollar. Wareejinta shabakad khaldan waxay keeni kartaa lumin.",
        ],
      },
    ],
    faq: [
      {
        q: "USDT ma doollar dhab ah baa?",
        a: "Maya. Waa token dijitaal ah oo loogu talagalay inuu la socdo qiimaha doollarka, oo ay taageerto shirkadda Tether.",
      },
      {
        q: "Kee fiican, USDT mise USDC?",
        a: "Labaduba waa la isticmaalaa. USDC waxay caan ku tahay daahfurnaanta kaydadka; USDT waxay caan ku tahay isticmaalka ballaaran. Dooro midka adeeggaagu taageero.",
      },
      {
        q: "Maxaa dhacaya haddii aan shabakad khaldan u diro?",
        a: "Lacagta way lumi kartaa. Had iyo jeer hubi shabakadda qaatahu sheegay ka hor intaadan dirin.",
      },
    ],
    updated: "2026-09-19",
  },
  {
    slug: "sida-crypto-loo-iibsado-soomaaliya",
    title: "Sida crypto loogu iibsado Soomaaliya (EVC, bangi, PayPal)",
    description:
      "Tallaabooyinka lagu iibsado crypto Soomaaliya: akoon furasho, xaqiijinta aqoonsiga, lacag gelin EVC ah, iyo waxa la ogaado si aad uga badbaaddo khiyaanada.",
    keywords: [
      "sida crypto loo iibsado",
      "crypto soomaaliya",
      "iibso bitcoin soomaaliya",
      "usdt evc",
      "crypto evc plus",
    ],
    intro:
      "Soomaaliya, dad badan waxay crypto ku iibsadaan iyagoo isticmaalaya EVC Plus, wareejin bangi ama PayPal, iyagoo adeegsanaya suuq (exchange) oggolaaday. Halkan waxaa ku qoran tallaabooyinka guud iyo waxa la ogaado.",
    sections: [
      {
        heading: "Tallaabooyinka guud",
        body: [
          "1. Dooro adeeg lagu kalsoonaan karo oo sharci ah, oo cad cidda maamusha.",
          "2. Fur akoon, xaqiiji aqoonsigaaga (KYC). Adeegyada sharciga ahi waa inay kuu weydiiyaan.",
          "3. Lacag ku dar: EVC Plus, wareejin bangi ama PayPal, iyadoo ku xiran waxa adeeggu taageero.",
          "4. Ka hor intaadan iibsan, fahan waxa aad iibsanayso iyo khatarta ku jirta.",
        ],
      },
      {
        heading: "Calaamadaha khatarta",
        body: [
          "Ka digtoonow qof kuu ballanqaada faa'iido la dammaanad qaaday, qof ku weydiiya furahaaga sirta ah, ama qof kugu cadaadiya inaad degdeg u dirto lacag. Kuwaasi waa calaamadaha khiyaanada.",
        ],
      },
      {
        heading: "FTL",
        body: [
          "FTL Exchange waa adeeg ka shaqeeya Soomaaliya oo aqbala lacag gelin EVC ah, wareejin bangi iyo PayPal, kana bixiya bangi, EVC ama PayPal. Ganacsigu wuxuu u baahan yahay codsi gaar ah: xaqiijin aqoonsi, dib u eegis iyo oggolaansho.",
        ],
      },
    ],
    faq: [
      {
        q: "Ma ku iibsan karaa crypto EVC Plus?",
        a: "Adeegyada qaar ayaa aqbala lacag gelin EVC ah. Hubi in adeeggu sharci yahay oo cidda maamushaa cad tahay.",
      },
      {
        q: "Maxaan u baahanahay si aan akoon u furo?",
        a: "Badanaa iimayl, eray sir ah, iyo marka dambe xaqiijinta aqoonsiga (sida baasaboor ama kaarka aqoonsiga) si aad u ganacsato ama lacag u bixiso.",
      },
      {
        q: "Immisa ayaan ku bilaabi karaa?",
        a: "Adeeg kasta wuxuu leeyahay xad u gaar ah. Ha galin lacag aadan awoodin inaad lumiso.",
      },
    ],
    updated: "2026-09-19",
  },
  {
    slug: "boorso-crypto",
    title: "Boorso crypto (wallet): waa maxay, sidee loo ilaaliyaa?",
    description:
      "Boorso crypto ma hayso lacagta, waxay haysaa furayaasha. Baro farqiga boorsada aad adigu haysato iyo tan shirkad kuu haysato, iyo sida loo ilaaliyo.",
    keywords: ["boorso crypto", "crypto wallet", "wallet af soomaali", "seed phrase", "furaha sirta ah"],
    intro:
      "Boorso crypto (wallet) waa barnaamij ama qalab haya furayaasha caddeeya in crypto-gu kuu gaar yahay. Lacagtu blockchain-ka ayay ku jirtaa; boorsaduna waa furaha.",
    sections: [
      {
        heading: "Cinwaan, furaha sirta ah iyo weedha soo celinta",
        body: [
          "Cinwaanku waa meesha lacagta laguu soo diro, waana la wadaagi karaa. Furaha sirta ah waa sirta oggolaata dirista lacagta: weligaa ha la wadaagin. Weedha soo celinta (12 ama 24 eray) ayaa dib u dhisi karta boorsada oo dhan.",
        ],
      },
      {
        heading: "Adigu haysta iyo shirkad haysa",
        body: [
          "Boorsada aad adigu furaha u haysato (self-custody): qofna ma xannibi karo lacagtaada, laakiin haddii aad lumiso weedha, qofna dib kuuma soo celin karo.",
          "Boorsada shirkad kuu haysato (custodial): waxaad ku gashaa iimayl iyo eray sir ah; ilaali akoonkaaga eray sir ah oo adag iyo xaqiijin laba-tallaabo ah.",
        ],
      },
    ],
    faq: [
      {
        q: "Haddii aan lumiyo taleefankayga, lacagtaydu ma lumaysaa?",
        a: "Haddii aad haysato weedha soo celinta, waxaad boorsada ku soo celin kartaa taleefan kale. Haddii kale, way lumi kartaa.",
      },
      {
        q: "Ma la wadaagi karaa weedha soo celinta?",
        a: "Maya, weligaa. Qof kasta oo haysta wuxuu qaadan karaa lacagtaada oo dhan.",
      },
      {
        q: "Hardware wallet waa maxay?",
        a: "Qalab yar oo furaha ku haya chip ammaan ah, oo ka fogeeya internetka. Waa habka ugu ammaansan ee lacag badan.",
      },
    ],
    updated: "2026-09-19",
  },
  {
    slug: "khiyaanada-crypto",
    title: "Khiyaanada crypto: sida loo aqoonsado oo looga badbaado",
    description:
      "Noocyada khiyaanada crypto ee ugu badan: taageero been abuur ah, hadiyado labanlaab, links phishing, faa'iido la dammaanad qaaday. Baro calaamadaha.",
    keywords: ["khiyaanada crypto", "crypto scam", "phishing", "khiyaano online", "ammaanka crypto"],
    intro:
      "Khiyaanooleyaashu waxay ku tiirsan yihiin degdeg, kalsooni iyo jahwareer. Aqoonta qaababkooda ayaa ah ilaalinta ugu xooggan.",
    sections: [
      {
        heading: "Noocyada ugu badan",
        body: [
          "Taageero been abuur ah: qof sheegta inuu ka yimid shirkad oo ku weydiiya code ama weedhaada soo celinta.",
          "Hadiyado iyo labanlaab: \"Ii soo dir, labanlaab ayaan kuu soo celinayaa.\" Weligeed run maaha.",
          "Links phishing: website u eg kan dhabta ah oo xada waxaad qorto.",
          "Faa'iido la dammaanad qaaday: nidaam ballanqaada faa'iido maalinle ah oo aan khatar lahayn.",
          "Jacayl iyo saaxiibtinimo: qof cusub oo online ah oo toddobaadyo kadib kuu soo bandhiga \"fursad\".",
        ],
      },
      {
        heading: "Xeerarka ilaalinta",
        body: [
          "Weligaa ha la wadaagin furaha sirta ah ama weedha soo celinta. Cinwaannada website-yada muhiimka ah adigu qor. Degdegu waa calaamad digniin. Haddii ay u muuqato wax aad u fiican, run maaha.",
        ],
      },
    ],
    faq: [
      {
        q: "Maxaan sameeyaa haddii la i khiyaameeyay?",
        a: "Jooji dirista lacag kale, beddel erayada sirta ah, la xiriir adeegga aad isticmaashay, oo u sheeg booliiska. Wareejinta blockchain inta badan lama celin karo.",
      },
      {
        q: "Shirkad dhab ah ma i weydiin kartaa weedha soo celinta?",
        a: "Maya. Shirkad dhab ah iyo taageere dhab ah weligood kuma weydiin doonaan.",
      },
      {
        q: "Sidee u ogaadaa website been abuur ah?",
        a: "Hubi cinwaanka xaraf xaraf. Link ka yimid fariin aan la filayn ha raacin; adigu qor cinwaanka.",
      },
    ],
    updated: "2026-09-19",
  },
  {
    slug: "qaamuuska-crypto",
    title: "Qaamuuska crypto: ereyada crypto oo af-Soomaali lagu sharraxay",
    description:
      "Ereyada crypto ee ugu muhiimsan oo af-Soomaali lagu sharraxay: blockchain, wallet, seed phrase, stablecoin, KYC, gas fee, exchange iyo in ka badan.",
    keywords: ["qaamuus crypto", "ereyada crypto", "crypto af soomaali", "blockchain macnaha", "KYC macnaha"],
    intro:
      "Crypto wuxuu leeyahay erayo badan oo cusub. Halkan waxaa ku yaal kuwa ugu muhiimsan, mid walba jumlad fudud.",
    sections: [
      {
        heading: "Ereyada aasaasiga ah",
        body: [
          "Blockchain: diiwaan la wadaago oo ay hayaan kombiyuutarro badan, oo aan la beddeli karin.",
          "Cryptocurrency (crypto): lacag dijitaal ah oo ku diiwaangashan blockchain.",
          "Token: hanti dijitaal ah oo ku dhisan blockchain.",
          "Stablecoin: crypto loogu talagalay inuu la socdo qiimaha lacag caadi ah, sida USDT iyo USDC.",
          "Wallet (boorso): barnaamij ama qalab haya furayaashaada.",
          "Seed phrase (weedha soo celinta): 12 ama 24 eray oo dib u dhisi kara boorsada.",
          "Private key (furaha sirta ah): sirta oggolaata dirista lacagta.",
          "Address (cinwaan): meesha crypto laguu soo diro.",
        ],
      },
      {
        heading: "Ereyada suuqa",
        body: [
          "Exchange (suuq): adeeg lagu iibsado oo lagu iibiyo crypto.",
          "KYC: xaqiijinta aqoonsiga, oo sharcigu dalbado.",
          "Gas fee: khidmadda la bixiyo si wareejin loogu diiwaangeliyo blockchain.",
          "Network (shabakad): blockchain-ka wareejintu ku socoto, sida Ethereum, Base ama Tron.",
          "Volatility: isbeddelka degdegga ah ee qiimaha.",
          "Custody: cidda haysa furayaasha: adiga ama shirkad.",
        ],
      },
    ],
    faq: [
      {
        q: "Maxay kala yihiin coin iyo token?",
        a: "Coin wuxuu leeyahay blockchain u gaar ah (sida Bitcoin). Token wuxuu ku dhisan yahay blockchain kale (sida USDC oo ku jira Ethereum).",
      },
      {
        q: "Gas fee maxaa loo bixiyaa?",
        a: "Waxaa la siiyaa kombiyuutarrada shabakadda si ay u diiwaangeliyaan wareejintaada.",
      },
      {
        q: "KYC maxaa loo baahan yahay?",
        a: "Sharciga lacag-dhaqidda iyo khiyaanada ka hortagga ayaa dalba in adeegyadu ogaadaan cidda macaamiishooda yihiin.",
      },
    ],
    updated: "2026-09-19",
  },
];

export const LEARN_ARTICLE_SLUGS = LEARN_ARTICLES.map((article) => article.slug);

export function findLearnArticle(slug: string): LearnArticle | undefined {
  return LEARN_ARTICLES.find((article) => article.slug === slug);
}
