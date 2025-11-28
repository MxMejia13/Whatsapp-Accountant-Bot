const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const width = 800;
const height = 600;

const chartJSNodeCanvas = new ChartJSNodeCanvas({
  width,
  height,
  backgroundColour: 'white'
});

/**
 * Generate a chart image from data
 * @param {Object} chartData - Chart configuration object
 * @returns {Buffer} PNG image buffer
 */
async function generateChart(chartData) {
  const { chartType = 'bar', title, data } = chartData;

  const configuration = {
    type: chartType,
    data: {
      labels: data.labels,
      datasets: [{
        label: title || 'Data',
        data: data.values,
        backgroundColor: [
          'rgba(255, 99, 132, 0.7)',
          'rgba(54, 162, 235, 0.7)',
          'rgba(255, 206, 86, 0.7)',
          'rgba(75, 192, 192, 0.7)',
          'rgba(153, 102, 255, 0.7)',
          'rgba(255, 159, 64, 0.7)',
          'rgba(199, 199, 199, 0.7)',
          'rgba(83, 102, 255, 0.7)',
          'rgba(255, 99, 255, 0.7)',
          'rgba(99, 255, 132, 0.7)'
        ],
        borderColor: [
          'rgba(255, 99, 132, 1)',
          'rgba(54, 162, 235, 1)',
          'rgba(255, 206, 86, 1)',
          'rgba(75, 192, 192, 1)',
          'rgba(153, 102, 255, 1)',
          'rgba(255, 159, 64, 1)',
          'rgba(199, 199, 199, 1)',
          'rgba(83, 102, 255, 1)',
          'rgba(255, 99, 255, 1)',
          'rgba(99, 255, 132, 1)'
        ],
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: title || 'Chart',
          font: {
            size: 20
          }
        },
        legend: {
          display: chartType === 'pie',
          position: 'bottom'
        }
      },
      scales: chartType !== 'pie' ? {
        y: {
          beginAtZero: true,
          grid: {
            color: 'rgba(0, 0, 0, 0.1)'
          }
        },
        x: {
          grid: {
            color: 'rgba(0, 0, 0, 0.1)'
          }
        }
      } : {}
    }
  };

  const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
  return imageBuffer;
}

/**
 * Generate a simple table image
 * @param {Object} tableData - Table data with headers and rows
 * @returns {Buffer} PNG image buffer
 */
async function generateTable(tableData) {
  const { headers, rows, title } = tableData;

  // Use chart.js to create a simple table visualization
  // For better tables, consider using HTML to canvas conversion
  const canvas = createCanvas(800, 600);
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 800, 600);

  // Draw title
  ctx.fillStyle = 'black';
  ctx.font = 'bold 24px Arial';
  ctx.fillText(title || 'Table', 20, 40);

  // Simple table rendering (basic implementation)
  let y = 80;
  const cellHeight = 30;
  const cellWidth = 150;

  // Draw headers
  ctx.font = 'bold 14px Arial';
  headers.forEach((header, i) => {
    ctx.fillText(header, 20 + (i * cellWidth), y);
  });

  // Draw rows
  ctx.font = '12px Arial';
  y += cellHeight;
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, cellIndex) => {
      ctx.fillText(String(cell), 20 + (cellIndex * cellWidth), y);
    });
    y += cellHeight;
  });

  return canvas.toBuffer('image/png');
}

module.exports = {
  generateChart,
  generateTable
};
