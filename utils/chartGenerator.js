const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { createCanvas } = require('canvas');

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
 * Generate a spreadsheet-style table image
 * @param {Object} tableData - Table data with headers and rows
 * @returns {Buffer} PNG image buffer
 */
async function generateTable(tableData) {
  const { headers, rows, title } = tableData;

  // Calculate dimensions based on content
  const numCols = headers.length;
  const numRows = rows.length;
  const cellWidth = 150;
  const cellHeight = 35;
  const padding = 10;
  const headerHeight = 40;
  const titleHeight = title ? 60 : 20;

  const canvasWidth = Math.max(800, numCols * cellWidth + padding * 2);
  const canvasHeight = titleHeight + headerHeight + (numRows * cellHeight) + padding * 2;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Draw title
  if (title) {
    ctx.fillStyle = '#333';
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(title, canvasWidth / 2, 40);
  }

  const startX = padding;
  const startY = titleHeight;

  // Draw header row with background
  ctx.fillStyle = '#4A90E2';
  ctx.fillRect(startX, startY, numCols * cellWidth, headerHeight);

  // Draw header text
  ctx.fillStyle = 'white';
  ctx.font = 'bold 14px Arial';
  ctx.textAlign = 'center';
  headers.forEach((header, i) => {
    const x = startX + (i * cellWidth) + (cellWidth / 2);
    const y = startY + (headerHeight / 2) + 5;
    ctx.fillText(String(header), x, y);
  });

  // Draw data rows with alternating colors
  ctx.textAlign = 'center';
  ctx.font = '13px Arial';
  rows.forEach((row, rowIndex) => {
    const y = startY + headerHeight + (rowIndex * cellHeight);

    // Alternating row colors
    ctx.fillStyle = rowIndex % 2 === 0 ? '#f8f9fa' : 'white';
    ctx.fillRect(startX, y, numCols * cellWidth, cellHeight);

    // Draw cell text
    ctx.fillStyle = '#333';
    row.forEach((cell, cellIndex) => {
      const x = startX + (cellIndex * cellWidth) + (cellWidth / 2);
      const textY = y + (cellHeight / 2) + 5;
      ctx.fillText(String(cell), x, textY);
    });
  });

  // Draw grid lines
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 1;

  // Vertical lines
  for (let i = 0; i <= numCols; i++) {
    const x = startX + (i * cellWidth);
    ctx.beginPath();
    ctx.moveTo(x, startY);
    ctx.lineTo(x, startY + headerHeight + (numRows * cellHeight));
    ctx.stroke();
  }

  // Horizontal lines
  for (let i = 0; i <= numRows + 1; i++) {
    const y = startY + (i === 0 ? 0 : headerHeight + ((i - 1) * cellHeight));
    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(startX + (numCols * cellWidth), y);
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}

module.exports = {
  generateChart,
  generateTable
};
