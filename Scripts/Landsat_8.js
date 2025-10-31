// =============================================
// CONFIGURACIÓN INICIAL
// =============================================

var municipio = ee.FeatureCollection("projects/ee-cveram/assets/Municipio");
var UPZ = ee.FeatureCollection("projects/ee-cveram/assets/UPZ");
Map.addLayer(UPZ, {color: 'blue', opacity: 0.3}, 'UPZ');

var areaOriginal = ee.Geometry.Polygon([
  [-74.37473594114549, 4.435830985641993],
  [-73.85455307981736, 4.435830985641993],
  [-73.85455307981736, 4.9244534103264645],
  [-74.37473594114549, 4.9244534103264645],
  [-74.37473594114549, 4.435830985641993]
]);

var areaReducida = areaOriginal.buffer(-500);
var interseccion = areaReducida.intersection(municipio.geometry(), ee.ErrorMargin(1));

// =============================================
// FUNCIONES AUXILIARES
// =============================================

var maskCloudsL8 = function(image) {
  var qa = image.select('QA_PIXEL');
  var fill = qa.bitwiseAnd(1 << 0).eq(0);
  var dilatedCloud = qa.bitwiseAnd(1 << 1).eq(0);
  var cirrus = qa.bitwiseAnd(1 << 2).eq(0);
  var cloud = qa.bitwiseAnd(1 << 3).eq(0);
  var cloudShadow = qa.bitwiseAnd(1 << 4).eq(0);
  var snow = qa.bitwiseAnd(1 << 5).eq(0);

  var cloudConf = qa.rightShift(8).bitwiseAnd(3);
  var shadowConf = qa.rightShift(10).bitwiseAnd(3);

  var cloudConfMask = cloudConf.lt(2);
  var shadowConfMask = shadowConf.lt(2);

  return image.updateMask(
    fill.and(dilatedCloud).and(cirrus).and(cloud).and(cloudShadow).and(snow)
    .and(cloudConfMask).and(shadowConfMask)
  );
};

var loadLandsatCollection = function(collectionId, startYear, endYear) {
  return ee.ImageCollection(collectionId)
    .filterBounds(interseccion)
    .filterDate(startYear + '-01-01', endYear + '-12-31')
    .map(maskCloudsL8);
};

var validateReflectance = function(image) {
  var inRange = image.gte(0).and(image.lte(1));
  return image
    .updateMask(inRange)
    .unmask(-9999)
    .toFloat()
    .set('valid_pixels', inRange.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: interseccion,
      scale: 30,
      maxPixels: 1e9
    }));
};


// =============================================
// FUNCIÓN DE UMBRAL DE OTSU
// =============================================
function otsuThreshold(image, region) {
  var histogram = image.reduceRegion({
    reducer: ee.Reducer.histogram(255),
    geometry: region,
    scale: 30,
    bestEffort: true,
    maxPixels: 1e8
  });

  var histDict = ee.Dictionary(histogram.get(image.bandNames().get(0)));
  var hist = ee.List(histDict.get('histogram'));
  var bins = ee.List(histDict.get('bucketMeans'));

  var total = ee.Number(hist.reduce(ee.Reducer.sum()));

  var computeOtsu = ee.List.sequence(1, hist.length().subtract(1)).map(function(i) {
    i = ee.Number(i);

    var w0 = ee.Number(hist.slice(0, i).reduce(ee.Reducer.sum())).divide(total);
    var w1 = ee.Number(hist.slice(i).reduce(ee.Reducer.sum())).divide(total);

    var mu0 = ee.Number(
      ee.List.sequence(0, i.subtract(1)).map(function(j) {
        j = ee.Number(j);
        return ee.Number(hist.get(j)).multiply(ee.Number(bins.get(j)));
      }).reduce(ee.Reducer.sum())
    ).divide(ee.Number(hist.slice(0, i).reduce(ee.Reducer.sum())));

    var mu1 = ee.Number(
      ee.List.sequence(i, hist.length().subtract(1)).map(function(j) {
        j = ee.Number(j);
        return ee.Number(hist.get(j)).multiply(ee.Number(bins.get(j)));
      }).reduce(ee.Reducer.sum())
    ).divide(ee.Number(hist.slice(i).reduce(ee.Reducer.sum())));

    var betweenVar = w0.multiply(w1).multiply(mu0.subtract(mu1).pow(2));
    return betweenVar;
  });

  var maxVar = computeOtsu.reduce(ee.Reducer.max());
  var index = computeOtsu.indexOf(maxVar);
  var threshold = bins.get(index);

  return ee.Number(threshold);
}



// =============================================
// PROCESAMIENTO ANUAL
// =============================================

var processYearlyData = function(collection, year, outputPrefix, previousMedian) {
  var bands = ['SR_B1','SR_B2','SR_B3','SR_B4','SR_B5','SR_B6','SR_B7'];

  var annualMedian = collection
    .filterDate(year + '-01-01', year + '-12-31')
    .median()
    .select(bands)
    .multiply(0.0000275).add(-0.2)
    .clip(interseccion);

  annualMedian = validateReflectance(annualMedian);
  var isMissingOrInvalid = annualMedian.eq(-9999).or(annualMedian.lt(0)).or(annualMedian.gt(1));
  var filledImage = annualMedian;

  var bestImage = collection
    .filterDate(year + '-01-01', year + '-12-31')
    .sort('CLOUD_COVER')
    .first()
    .select(bands)
    .multiply(0.0000275).add(-0.2)
    .clip(interseccion);

  bestImage = validateReflectance(bestImage);
  filledImage = filledImage.where(isMissingOrInvalid, bestImage);
  isMissingOrInvalid = filledImage.eq(-9999).or(filledImage.lt(0)).or(filledImage.gt(1));

  if (previousMedian) {
    var prevValid = previousMedian.neq(-9999).and(previousMedian.gte(0)).and(previousMedian.lte(1));
    filledImage = filledImage.where(isMissingOrInvalid, previousMedian.updateMask(prevValid));
    isMissingOrInvalid = filledImage.eq(-9999).or(filledImage.lt(0)).or(filledImage.gt(1));
  }

  var missingMask = filledImage.select('SR_B1').eq(-9999);
  var smallClusters = missingMask.and(
    missingMask.connectedPixelCount(100, true).lte(100)
  );

  var interpSource = filledImage.updateMask(
    filledImage.gte(0).and(filledImage.lte(1))
  );

  var spatialFill = interpSource.focalMean({
    radius: 2,
    kernelType: 'square',
    units: 'pixels'
  });

  filledImage = filledImage.where(smallClusters, spatialFill);
  filledImage = validateReflectance(filledImage);

  Export.image.toDrive({
    image: filledImage,
    description: outputPrefix + year + '_multiband',
    fileNamePrefix: outputPrefix + year + '_multiband',
    crs: 'EPSG:4326',
    region: interseccion,
    scale: 30,
    maxPixels: 1e13,
    fileFormat: 'GeoTIFF',
    formatOptions: {
      cloudOptimized: true,
      noData: -9999
    }
  });

  var visParams = {
    bands: ['SR_B4','SR_B3','SR_B2'],
    min: 0,
    max: 0.3
  };

  Map.addLayer(filledImage, visParams, 'Comp' + year, false);
 // Map.addLayer(filledImage.select('SR_B1').neq(-9999).selfMask(), {palette: ['green']}, 'Máscara válida ' + year, false);

  // Diagnóstico por banda: vacíos y porcentaje
  var vacioPorBanda = bands.map(function(bandName) {
    var banda = filledImage.select(bandName);
    var vacios = banda.eq(-9999);

    var total = banda.mask().reduceRegion({
      reducer: ee.Reducer.count(),
      geometry: interseccion,
      scale: 30,
      maxPixels: 1e9
    }).get(bandName);

    var nVacios = vacios.reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: interseccion,
      scale: 30,
      maxPixels: 1e9
    }).get(bandName);

    var porcentaje = ee.Number(nVacios).divide(ee.Number(total)).multiply(100);
    print('Año ' + year + ' - Banda ' + bandName + ': Vacíos =', nVacios, ', Porcentaje =', porcentaje);
    return ee.Image(vacios.rename(bandName));
  });

  var vaciosPorBanda = ee.ImageCollection(vacioPorBanda).toBands();
  var algunaBandaVacia = vaciosPorBanda.reduce(ee.Reducer.anyNonZero()).rename('Vacios_Alguna_Banda');
  Map.addLayer(algunaBandaVacia.selfMask(), {palette: ['red']}, 'Vacios en alguna banda ' + year, false);

  // Índices NDVI, NDWI, NDBI
  var ndvi = filledImage.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');
  var ndwi = filledImage.normalizedDifference(['SR_B3', 'SR_B5']).rename('NDWI');
  var ndbi = filledImage.normalizedDifference(['SR_B6', 'SR_B5']).rename('NDBI');

  Map.addLayer(ndvi, {min: 0, max: 1, palette: ['white', 'green']}, 'NDVI ' + year, false);
  Map.addLayer(ndwi, {min: -1, max: 1, palette: ['blue', 'white']}, 'NDWI ' + year, false);
  Map.addLayer(ndbi, {min: -1, max: 1, palette: ['white', 'brown']}, 'NDBI ' + year, false);
  
  // Umbral de Otsu
  var ndbiOtsu = otsuThreshold(ndbi, interseccion);
  print('Umbral Otsu NDBI - Año ' + year, ndbiOtsu);
  var ndbiBin = ndbi.gt(ndbiOtsu).rename('NDBI_bin');
  Map.addLayer(ndbiBin.selfMask(), {palette: ['gray', '#1f4e79']}, 'NDBI > Otsu ' + year, false);
  

  return annualMedian;
};


// =============================================
// EJECUCIÓN PRINCIPAL
// =============================================


var params = {
  startYear: 2013,
  endYear: 2024,
  collectionId: 'LANDSAT/LC08/C02/T1_L2',
  outputPrefix: 'landsat_'
};

var landsatCol = loadLandsatCollection(
  params.collectionId,
  params.startYear,
  params.endYear
);

var previousMedian = null;
for (var year = params.startYear; year <= params.endYear; year++) {
  print('================================');
  print('Procesando año: ' + year);
  previousMedian = processYearlyData(
    landsatCol,
    year,
    params.outputPrefix,
    previousMedian
  );
}

Map.centerObject(interseccion, 10);
Map.addLayer(interseccion, {color: 'red', opacity: 0.3}, 'Área de estudio');
