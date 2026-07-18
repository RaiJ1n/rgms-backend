const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  name: { type: String, 
          required: true, 
            trim: true },

  duration: { type: String, required: true, 
              trim: true },

  price: { type: Number, 
          required: true },

  description: { type: String, 
                  trim: true },

}, { timestamps: true });

module.exports = mongoose.model('MembershipPlan', planSchema);
