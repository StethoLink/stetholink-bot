/**
 * Public given and family names, used two ways by the de-identification layer:
 * the surrogate pools supply the stand-in a real name is replaced with (same sex, same naming
 * culture, both scripts), and the lexicon lets the layer recognise a name in free text that the
 * chart did not supply. These are common names, not records of anyone; fictional test people
 * live under `tests/fixtures`.
 *
 * Surrogates are chosen from names that are rarely ordinary words, so a stand-in is not confused
 * with clinical text when the answer is mapped back.
 */
const pairs = (list: string) => list.trim().split(/\s*,\s*/).map((pair) => { const [ar, la] = pair.split("/"); return { ar, la }; });

export const SURROGATE_GIVEN_MALE = pairs(`
خالد/Khalid, فيصل/Faisal, طلال/Talal, مازن/Mazen, وليد/Waleed, زياد/Ziyad, هشام/Hisham, بندر/Bandar, نواف/Nawaf, مشعل/Mishal,
راكان/Rakan, ثامر/Thamer, أنس/Anas, يزن/Yazan, باسل/Basel, عمر/Omar, إبراهيم/Ibrahim, يوسف/Yousef, إسماعيل/Ismail, يعقوب/Yaqoub,
سلمان/Salman, مروان/Marwan, أيمن/Ayman, عثمان/Othman, حمزة/Hamza, طارق/Tariq, رياض/Riyadh, غسان/Ghassan, معاذ/Muath, إياد/Eyad`);

export const SURROGATE_GIVEN_FEMALE = pairs(`
ريم/Reem, لمى/Lama, غادة/Ghada, سارة/Sarah, مريم/Maryam, فاطمة/Fatimah, عائشة/Aisha, خديجة/Khadija, زينب/Zainab, نورة/Norah,
منيرة/Munira, لينا/Lina, رنا/Rana, ديمة/Deema, لجين/Lujain, هيفاء/Haifa, سلمى/Salma, ليلى/Layla, رزان/Razan, دانة/Dana,
أسماء/Asma, حنان/Hanan, سمية/Sumaya, رهف/Rahaf, شيماء/Shaima, نجلاء/Najla, عبير/Abeer, مها/Maha, هيا/Haya, جواهر/Jawaher`);

/** Family names without the article; the article of the original is kept when it is replaced. */
export const SURROGATE_FAMILY = pairs(`
حربي/Harbi, قحطاني/Qahtani, شهري/Shehri, غامدي/Ghamdi, زهراني/Zahrani, دوسري/Dosari, مطيري/Mutairi, عنزي/Anazi, شمري/Shammari, سبيعي/Subaie,
بلوي/Balawi, جهني/Juhani, مالكي/Malki, عمري/Amri, أحمدي/Ahmadi, عسيري/Asiri, يامي/Yami, رشيدي/Rashidi, ثقفي/Thaqafi, خالدي/Khaldi,
حازمي/Hazmi, زبيدي/Zubaidi, نعمي/Nuami, فيفي/Faifi, قرني/Qarni, سلمي/Sulami, بقمي/Buqami, حكمي/Hakami, عطوي/Atawi, لحياني/Lihyani`);

const latin = (list: string) => list.trim().split(/\s*,\s*/).map((la) => ({ ar: la, la }));
/** Stand-ins for names that are not Arabic. */
export const SURROGATE_INTL_MALE = latin("Daniel, Peter, Martin, Simon, Oliver, Victor, Adrian, Felix, Julian, Marcus, Tobias, Edgar");
export const SURROGATE_INTL_FEMALE = latin("Helen, Laura, Clara, Julia, Nina, Alice, Irene, Monica, Teresa, Vera, Sonia, Edith");
export const SURROGATE_INTL_FAMILY = latin("Miller, Carter, Bennett, Foster, Hayes, Porter, Walsh, Reeves, Lawson, Brandt, Keller, Nolan");

/** Common given names recognised in free text. Names that are also everyday clinical words (for example the word for a cream) are left out. */
export const LEXICON_MALE = pairs(`
محمد/Mohammed, أحمد/Ahmed, علي/Ali, عبدالله/Abdullah, عبدالرحمن/Abdulrahman, عبدالعزيز/Abdulaziz, سعود/Saud, سعد/Saad, فهد/Fahad, سلطان/Sultan,
ناصر/Nasser, تركي/Turki, ماجد/Majed, سعيد/Saeed, صالح/Saleh, حسن/Hassan, حسين/Hussein, مصطفى/Mustafa, محمود/Mahmoud, عادل/Adel,
سامي/Sami, رامي/Rami, هاني/Hani, فادي/Fadi, نايف/Naif, مساعد/Musaed, منصور/Mansour, بدر/Bader, عبدالمجيد/Abdulmajeed, عبدالملك/Abdulmalik,
سليمان/Sulaiman, داود/Dawood, موسى/Mousa, عيسى/Eisa, يحيى/Yahya, زكريا/Zakaria, إدريس/Idris, هادي/Hadi, مهدي/Mahdi, جعفر/Jaafar,
كاظم/Kadhim, عباس/Abbas, قاسم/Qasim, حمد/Hamad, حمدان/Hamdan, راشد/Rashed, مبارك/Mubarak, عايض/Ayedh, مطلق/Mutlaq, فلاح/Falah,
سالم/Salem, غازي/Ghazi, فواز/Fawaz, نبيل/Nabil, سمير/Samir, جمال/Jamal, كمال/Kamal, عماد/Emad, أسامة/Osama, بلال/Bilal,
عمار/Ammar, ياسر/Yasser, أشرف/Ashraf, شريف/Sharif, حاتم/Hatem, حازم/Hazem, أمين/Amin, رائد/Raed, وائل/Wael, جابر/Jaber,
عبدالكريم/Abdulkarim, عبداللطيف/Abdullatif, عبدالإله/Abdulelah, عبدالمحسن/Abdulmohsen, عبدالهادي/Abdulhadi, مهند/Muhannad, ريان/Rayan, عزام/Azzam, مشاري/Mishari, صقر/Saqr`);

export const LEXICON_FEMALE = pairs(`
نوف/Nouf, العنود/Alanoud, أمل/Amal, نور/Noor, هدى/Huda, منى/Mona, وفاء/Wafa, سعاد/Suad, نادية/Nadia, سميرة/Samira,
جميلة/Jamila, لطيفة/Latifa, حصة/Hessa, موضي/Moudi, شيخة/Sheikha, مشاعل/Mashael, بدور/Budoor, أروى/Arwa, رغد/Raghad, شهد/Shahad,
جود/Joud, غدير/Ghadeer, أمينة/Amina, آمنة/Amna, حليمة/Halima, صفية/Safiya, رقية/Ruqaya, أم كلثوم/Umm Kulthum, هاجر/Hajar, إيمان/Iman,
إسراء/Israa, آلاء/Alaa, دعاء/Duaa, ولاء/Walaa, سناء/Sanaa, هناء/Hanaa, ثناء/Thanaa, رحاب/Rehab, نهى/Nuha, ندى/Nada,
هالة/Hala, تالا/Tala, ميار/Mayar, ملاك/Malak, جنى/Jana, لانا/Lana, يارا/Yara, ياسمين/Yasmin, بشرى/Bushra, عزة/Azza,
فوزية/Fawzia, نوال/Nawal, ابتسام/Ibtisam, انتصار/Intisar, خلود/Khulood, عهود/Ohoud, وعد/Waad, أفنان/Afnan, بيان/Bayan, شروق/Shurooq`);
