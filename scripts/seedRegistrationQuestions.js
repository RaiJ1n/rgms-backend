const mongoose = require('mongoose');
require('dotenv').config();
const CoachQuestion = require('../models/CoachQuestion');

const questions = [
  { question: 'Do you have any allergies? If yes, can you list all of it?', type: 'text', options: [], isActive: true, order: 1 },
  { question: 'What is your goal?', type: 'choice', options: ['Weight Loss', 'Bulking', 'Lean Bulk', 'Fat Loss', 'Body Recomposition'], isActive: true, order: 2 },
  { question: 'Do you do any walking, sports, or physical activities?', type: 'text', options: [], isActive: true, order: 3 },
  { question: 'How many days per week can you realistically exercise?', type: 'choice', options: ['1 - 3 days', '4 - 5 days', '6 days'], isActive: true, order: 4 },
  { question: 'What time of day are you most likely to stick with it?', type: 'text', options: [], isActive: true, order: 5 },
  { question: 'Do you currently have any injuries, pain, or movement limitations that could affect exercise?', type: 'text', options: [], isActive: true, order: 6 },
  { question: 'Has a healthcare professional ever told you to avoid or limit certain types of physical activity?', type: 'text', options: [], isActive: true, order: 7 },
  { question: 'How is your sleep?', type: 'text', options: [], isActive: true, order: 8 },
  { question: 'How stressful is your typical week?', type: 'text', options: [], isActive: true, order: 9 },
  { question: 'How would you describe your current eating habits?', type: 'text', options: [], isActive: true, order: 10 },
  { question: 'How physically demanding is your daily work or routine?', type: 'text', options: [], isActive: true, order: 11 },
  { question: 'What do you think might stop you from exercising consistently?', type: 'multi_choice', options: ['Lack of time', 'Motivation', 'Feeling intimidated', 'Not knowing what to do', 'Getting bored', 'Feeling too tired'], isActive: true, order: 12 },
];

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  let created = 0;
  for (const q of questions) {
    const exists = await CoachQuestion.findOne({ question: q.question });
    if (!exists) {
      await CoachQuestion.create(q);
      created += 1;
    }
  }
  console.log(`Seeded ${created} new questions (${questions.length} total defined).`);
  await mongoose.disconnect();
}

seed().catch((err) => { console.error(err); process.exit(1); });
