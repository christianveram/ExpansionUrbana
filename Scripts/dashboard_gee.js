// ================== 1. ASSETS ==================
var upz = ee.FeatureCollection("projects/ee-cveram/assets/UPZ_DATOS");
var years = [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];

// ================== 2. PARÁMETROS DE VISUALIZACIÓN ==================
var visClas = { min: 0, max: 1, palette: ['green', 'red'] };
var upzStyle = { color: 'black', fillColor: '00000000' };

// ================== 2b. Función auxiliar para convertir a km² y redondear a 2 decimales (server-side)
function toKm2Rounded(numberServer) {
  return ee.Number(numberServer).divide(1e6).multiply(100).round().divide(100);
}

// ================== 3. FUNCIÓN PARA MOSTRAR CAPAS ==================
var leftMap = ui.Map();
leftMap.setControlVisibility(false);

var rightMap = ui.Map();
rightMap.setControlVisibility(false);

var linker = ui.Map.Linker([leftMap, rightMap]);

var splitPanel = ui.SplitPanel({
  firstPanel: leftMap,
  secondPanel: rightMap,
  orientation: 'horizontal',
  wipe: true
});

ui.root.clear();
ui.root.add(splitPanel);

function showYear(year) {
  leftMap.layers().reset();
  rightMap.layers().reset();
  
  var landsat = ee.Image("projects/ee-cveram/assets/landsat_" + year + "_multiband");
  var clasif  = ee.Image("projects/ee-cveram/assets/reclasificado_" + year);
  
  var landsatClipped = landsat.clip(upz);
  var clasifClipped = clasif.clip(upz);
  
  var percentileValues = landsatClipped.reduceRegion({
    reducer: ee.Reducer.percentile([2, 98]),
    geometry: upz.geometry(),
    scale: 30,
    maxPixels: 1e9,
    bestEffort: true
  });
  
  var minValues = [
    percentileValues.get('b4_p2'),
    percentileValues.get('b3_p2'),
    percentileValues.get('b2_p2')
  ];
  
  var maxValues = [
    percentileValues.get('b4_p98'),
    percentileValues.get('b3_p98'),
    percentileValues.get('b2_p98')
  ];
  
  var landsatVisualized = landsatClipped.visualize({
    bands: ['b4', 'b3', 'b2'],
    min: minValues,
    max: maxValues
  });
  
  leftMap.addLayer(landsatVisualized, null, "Landsat " + year);
  leftMap.addLayer(upz.style(upzStyle), {}, "Límites UPZ");
  
  rightMap.addLayer(clasifClipped, visClas, "Clasificación " + year);
  rightMap.addLayer(upz.style(upzStyle), {}, "Límites UPZ");
  
  leftMap.centerObject(upz);
}

// ================== 4. PANEL PRINCIPAL ==================
var panel = ui.Panel({
  style: {width: '350px', padding: '8px', backgroundColor: 'rgba(255,255,255,0.9)'}
});

panel.add(ui.Label({
  value: 'Dashboard Expansión Urbana y Pobreza',
  style: {fontSize: '18px', fontWeight: 'bold', color: '#1a5276'}
}));

panel.add(ui.Label({
  value: 'Seleccione un año para visualizar las capas',
  style: {fontSize: '12px', color: 'gray'}
}));

var yearSelect = ui.Select({
  items: years.map(String),
  placeholder: 'Selecciona un año',
  onChange: function(y) {
    if (y) showYear(parseInt(y));
  }
});

panel.add(ui.Label('🗓 Año:'));
panel.add(yearSelect);
panel.add(ui.Label(''));

// ================== 5. PANELES EN EL MAPA DERECHO ==================
var infoPanel = ui.Panel({
  style: {
    position: 'bottom-right',
    padding: '8px',
    backgroundColor: 'rgba(255,255,255,0.8)',
    width: '300px'
  }
});

var totalAreaChartPanel = ui.Panel({
  style: {
    position: 'top-right',
    padding: '8px',
    backgroundColor: 'rgba(255,255,255,0.8)',
    width: '300px'
  }
});

// ================== 6. SELECCIÓN DE UPZ CON LOCALIDAD ==================
var selectedUpzList = [];
var upzSelectionPanel = ui.Panel({
  style: {padding: '8px', border: '1px solid #ccc', margin: '10px 0'}
});
upzSelectionPanel.add(ui.Label('UPZ seleccionadas:', {fontWeight: 'bold'}));

var upzSelect;

upz.distinct(['UPZ', 'LOCALIDAD']).aggregate_array('UPZ').evaluate(function(upzNames) {
  upz.distinct(['UPZ', 'LOCALIDAD']).aggregate_array('LOCALIDAD').evaluate(function(localidades) {
    var combinedItems = [];
    for (var i = 0; i < upzNames.length; i++) {
      combinedItems.push(upzNames[i] + ' (' + localidades[i] + ')');
    }
    
    upzSelect = ui.Select({
      items: combinedItems.sort(),
      placeholder: 'Selecciona una UPZ (con localidad)'
    });
    
    var addButton = ui.Button({
      label: 'Añadir UPZ a comparación',
      onClick: function() {
        var selectedValue = upzSelect.getValue();
        if (selectedValue) {
          var upzName = selectedValue.split(' (')[0];
          if (selectedUpzList.indexOf(upzName) === -1) {
            selectedUpzList.push(upzName);
            upzSelectionPanel.add(ui.Label('• ' + selectedValue));
            updateComparisonCharts();
          }
        }
      },
      style: {margin: '5px 0'}
    });
    
    var clearButton = ui.Button({
      label: 'Limpiar selección',
      onClick: function() {
        selectedUpzList = [];
        upzSelectionPanel.clear();
        upzSelectionPanel.add(ui.Label('UPZ seleccionadas:', {fontWeight: 'bold'}));
        updateComparisonCharts();
      },
      style: {margin: '0'}
    });
    
    panel.add(ui.Label('Selecciona una UPZ para comparar:'));
    panel.add(upzSelect);
    panel.add(addButton);
    panel.add(upzSelectionPanel);
    panel.add(clearButton);
  });
});

// ================== 6B. FUNCIÓN PARA ACTUALIZAR GRÁFICOS 
function updateComparisonCharts() {
  infoPanel.clear();
  if (selectedUpzList.length === 0) {
    infoPanel.add(ui.Label('Selecciona UPZ para ver los gráficos de comparación.'));
    return;
  }
  
  infoPanel.add(ui.Label('Comparación de UPZ', {fontWeight: 'bold'}));
  
  var featuresFiltered = upz
    .filter(ee.Filter.inList('UPZ', selectedUpzList))
    .distinct(['AÑO', 'UPZ'])
    .map(function(f) {
      return f.set({
        URBANO: toKm2Rounded(f.get('URBANO')),
        OTROS: toKm2Rounded(f.get('OTROS')),
        LOCALIDAD: f.get('LOCALIDAD')
      });
    });
  
  var featuresWithLabel = featuresFiltered.map(function(f) {
    return f.set('label', ee.String(f.get('UPZ')).cat(' (').cat(f.get('LOCALIDAD')).cat(')'));
  });
  
  var chartUrban = ui.Chart.feature.groups({
    features: featuresWithLabel,
    xProperty: 'AÑO',
    yProperty: 'URBANO',
    seriesProperty: 'label'
  }).setOptions({
    title: 'Evolución del Área Urbana (km²)',
    vAxis: { title: 'Área (km²)', format: '##.##' },
    hAxis: { title: 'Año', format: '####' },
    legend: { position: 'right' },
    height: 140,
    width: '100%'
  });
  
  var chartNonUrban = ui.Chart.feature.groups({
    features: featuresWithLabel,
    xProperty: 'AÑO',
    yProperty: 'OTROS',
    seriesProperty: 'label'
  }).setOptions({
    title: 'Evolución del Área No Urbana (km²)',
    vAxis: { title: 'Área (km²)', format: '##.##' },
    hAxis: { title: 'Año', format: '####' },
    legend: { position: 'right' },
    height: 140,
    width: '100%'
  });
  
  var urbanPanel = ui.Panel({ widgets: [chartUrban], style: { height: '160px' } });
  var nonUrbanPanel = ui.Panel({ widgets: [chartNonUrban], style: { height: '160px' } });
  
  infoPanel.add(urbanPanel);
  infoPanel.add(nonUrbanPanel);
}

// ================== 7. LEYENDA Y CÁLCULO DE ÁREAS TOTALES ==================
function addLegend() {
  var legend = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {
      position: 'top-left',
      padding: '8px',
      backgroundColor: 'rgba(255,255,255,0.8)'
    }
  });
  
  legend.add(ui.Label('Leyenda (km²)', { fontWeight: 'bold' }));
  
  var palette = visClas.palette;
  var labels = ['Área No Urbana', 'Área Urbana'];
  
  palette.forEach(function(color, i) {
    var row = ui.Panel({ layout: ui.Panel.Layout.flow('horizontal') });
    row.add(ui.Label({ style: { backgroundColor: color, padding: '8px', margin: '0 4px 0 0' } }));
    row.add(ui.Label(labels[i]));
    legend.add(row);
  });
  
  rightMap.add(legend);
}

function getYearlyArea(y) {
  var featuresForYear = upz.filter(ee.Filter.eq('AÑO', y));
  var uniqueUPZ = featuresForYear.distinct(['AÑO', 'UPZ']);
  
  var urbanSum = toKm2Rounded(uniqueUPZ.aggregate_sum('URBANO'));
  var nonUrbanSum = toKm2Rounded(uniqueUPZ.aggregate_sum('OTROS'));
  
  return ee.Feature(null, { 
    'AÑO': y, 
    'Área Urbana (km²)': urbanSum, 
    'Área No Urbana (km²)': nonUrbanSum 
  });
}

function createTotalAreaChart() {
  totalAreaChartPanel.add(ui.Label('Áreas Totales por Año', { fontWeight: 'bold' }));
  totalAreaChartPanel.add(ui.Label('Cargando datos...'));

  var yearlyData = ee.FeatureCollection(
    years.map(getYearlyArea)
  );

  var totalChart = ui.Chart.feature.byFeature({
    features: yearlyData,
    xProperty: 'AÑO',
    yProperties: ['Área Urbana (km²)', 'Área No Urbana (km²)']
  }).setOptions({
    title: 'Evolución de Áreas Totales',
    vAxis: { title: 'Área Total (km²)', format: '##.##' },
    hAxis: { title: 'Año', format: '####' },
    series: {
      0: { color: 'red', pointSize: 5, lineWidth: 2 },
      1: { color: 'green', pointSize: 5, lineWidth: 2 }
    },
    legend: { position: 'right' }
  });

  totalAreaChartPanel.clear();
  totalAreaChartPanel.add(ui.Label('Áreas Totales por Año', { fontWeight: 'bold' }));
  totalAreaChartPanel.add(totalChart);
}

// ================== BONUS: Información al hacer clic en el mapa derecho ==================
var clickInfoPanel = ui.Panel({
  style: {
    position: 'bottom-left',
    padding: '8px',
    backgroundColor: 'rgba(255,255,255,0.95)',
    width: '240px',
    shown: false
  }
});
rightMap.add(clickInfoPanel);

function handleClick(coords) {
  var point = ee.Geometry.Point([coords.lon, coords.lat]);
  
  var within = upz.geometry().contains(point);
  within.evaluate(function(isInside) {
    if (!isInside) {
      clickInfoPanel.clear();
      clickInfoPanel.add(ui.Label('📍 Fuera del área de estudio', { color: 'gray' }));
      clickInfoPanel.style().set('shown', true);
      return;
    }

    var upzAtPoint = upz.filterBounds(point).first();
    var upzName = upzAtPoint.get('UPZ');
    var localidad = upzAtPoint.get('LOCALIDAD');

    ee.List([upzName, localidad]).evaluate(function(results) {
      var upzStr = results[0] || '—';
      var locStr = results[1] || '—';

      clickInfoPanel.clear();
      clickInfoPanel.add(ui.Label('UPZ: ' + upzStr));
      clickInfoPanel.add(ui.Label('Localidad: ' + locStr));
      clickInfoPanel.style().set('shown', true);

      if (selectedUpzList.indexOf(upzStr) === -1) {
        selectedUpzList.push(upzStr);
        upzSelectionPanel.clear();
        upzSelectionPanel.add(ui.Label('UPZ seleccionadas:', {fontWeight: 'bold'}));
        selectedUpzList.forEach(function(u) {
          var feat = upz.filter(ee.Filter.eq('UPZ', u)).first();
          feat.get('LOCALIDAD').evaluate(function(loc) {
            upzSelectionPanel.add(ui.Label('• ' + u + ' (' + (loc || '—') + ')'));
          });
        });
        updateComparisonCharts();
      }
    });
  });
}

rightMap.onClick(handleClick);
// ================== FIN BONUS ==================

// ================== 8. MOSTRAR PANELES Y VISTA INICIAL ==================
ui.root.insert(0, panel);
rightMap.add(infoPanel);
rightMap.add(totalAreaChartPanel); 

yearSelect.setValue('2024', true);
createTotalAreaChart();
addLegend();
updateComparisonCharts();
