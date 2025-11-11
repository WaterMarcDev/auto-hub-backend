const mongoose = require('mongoose');
const ElementHubHistory = require('./models/elementHubHistory.model');

mongoose.connect('mongodb://localhost:27017/autohub', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

async function test() {
  try {
    // Find a recent sell record
    const sell = await ElementHubHistory.findOne({ type: 'sell' })
      .populate('invoiceId')
      .populate('customerId', 'firstName lastName')
      .sort({ createdAt: -1 });
    
    if (!sell) {
      console.log('No sell records found');
    } else {
      console.log('Recent sell record:');
      console.log('- Element:', sell.elementName);
      console.log('- Amount:', sell.amount, sell.unit);
      console.log('- Customer:', sell.customerId ? `${sell.customerId.firstName} ${sell.customerId.lastName}` : 'N/A');
      console.log('- Invoice ID:', sell.invoiceId ? sell.invoiceId._id : 'NOT SET');
      console.log('- Created:', sell.createdAt);
    }
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    mongoose.connection.close();
  }
}

test();
