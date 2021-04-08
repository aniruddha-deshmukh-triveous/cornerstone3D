import { IImageCache } from '../types'
import triggerEvent from '../utilities/triggerEvent'
import eventTarget from '../eventTarget'
import EVENTS from '../enums/events'
import ERROR_CODES from '../enums/errorCodes'

const MAX_CACHE_SIZE_1GB = 1073741824

interface ImageLoadObject {
  promise: Promise
  cancel?: () => void
  decache?: () => void
}

interface VolumeLoadObject {
  promise: Promise
  cancel?: () => void
  decache?: () => void
}

interface CachedImage {
  image: any // TODO We need to type this
  imageId: string
  imageLoadObject: ImageLoadObject
  loaded: boolean
  sharedCacheKey?: string
  timeStamp: number
  sizeInBytes: number
}

interface CachedVolume {
  volume: any // TODO We need to type this
  volumeId: string
  volumeLoadObject: VolumeLoadObject
  loaded: boolean
  timeStamp: number
  sizeInBytes: number
}

class Cache implements IImageCache {
  private _imageCache: Map<string, CachedImage>
  private _volumeCache: Map<string, CachedVolume>
  private _cacheSize: number
  private _maxCacheSize: number

  constructor() {
    this._imageCache = new Map()
    this._volumeCache = new Map()
    this._cacheSize = 0
    this._maxCacheSize = MAX_CACHE_SIZE_1GB // Default 1GB
  }

  public setMaxCacheSize = (newMaxCacheSize: number) => {
    this._maxCacheSize = newMaxCacheSize

    if (this._maxCacheSize > this._cacheSize) {
      const errorMessage = `New max cacheSize ${this._maxCacheSize} larger than current cachesize ${this._cacheSize}. You should set the maxCacheSize before adding data to the cache.`
      throw new Error(errorMessage)
    }
  }

  // todo need another name for this function
  // should check if available cache space supports the volume
  // if it does, clean it up
  public checkCacheSizeCanSupportVolume = (byteLength: number) => {
    if (this.getCacheSize() + byteLength > this.getMaxCacheSize()) {
      throw new Error(ERROR_CODES.CACHE_SIZE_EXCEEDED)
    }
  }

  public getMaxCacheSize = (): number => this._maxCacheSize
  public getCacheSize = (): number => this._cacheSize

  private _decacheImage = (imageId: string) => {
    const { imageLoadObject } = this._imageCache.get(imageId)

    // Cancel any in-progress loading
    if (imageLoadObject.cancel) {
      imageLoadObject.cancel()
    }

    if (imageLoadObject.decache) {
      imageLoadObject.decache()
    }

    this._imageCache.delete(imageId)
  }

  // TODO: This probably should not exist,
  // we should just use loadVolume, but then we
  // need to update all tools (or provide a way to grab these
  // from the Scene synchronously
  public getImageVolume = (volumeId: string) => {
    const cachedVolume = this._volumeCache.get(volumeId)
    if (!cachedVolume) {
      throw new Error('Not present in cache')
    }

    return cachedVolume.volume
  }

  private _decacheVolume = (volumeId: string) => {
    const cachedVolume = this._volumeCache.get(volumeId)
    const { volumeLoadObject } = cachedVolume

    // Cancel any in-progress loading
    if (volumeLoadObject.cancel) {
      volumeLoadObject.cancel()
    }

    if (volumeLoadObject.decache) {
      volumeLoadObject.decache()
    }

    // Clear texture memory (it will probably only be released at garbage collection of the dom element, but might as well try)
    // TODO We need to actually check if this particular scalar is used.
    // TODO: Put this in the volume loader's decache function?
    /*if (volume && volume.vtkOpenGLTexture) {
      volume.vtkOpenGLTexture.releaseGraphicsResources()
    }*/

    this._volumeCache.delete(volumeId)
  }

  public decacheUntilBytesAvailable(numBytes: number): number {
    const bytesAvailable = this.getMaxCacheSize() - this.getCacheSize()
    if (bytesAvailable >= numBytes) {
      return bytesAvailable
    }

    while (bytesAvailable < numBytes) {
      const { value: imageId, done } = imageIterator.next()

      if (done) {
        break
      }

      this._decacheImage(imageId)
    }

    if (bytesAvailable >= numBytes) {
      return bytesAvailable
    }

    // This means that we were unable to decache enough images to
    // reach the demanded number of bytes
    return bytesAvailable
  }

  public purgeCache = () => {
    const imageIterator = this._imageCache.keys()

    /* eslint-disable no-constant-condition */
    while (true) {
      const { value: imageId, done } = imageIterator.next()

      if (done) {
        break
      }

      this._decacheImage(imageId)
    }

    const volumeIterator = this._volumeCache.keys()

    /* eslint-disable no-constant-condition */
    while (true) {
      const { value: volumeId, done } = volumeIterator.next()

      if (done) {
        break
      }

      this._decacheVolume(volumeId)
    }
  }

  /**
   * Purges the cache if size exceeds maximum
   * @returns {void}
   */
  private _purgeCacheIfNecessary() {
    // If max cache size has not been exceeded, do nothing
    if (this.getCacheSize() <= this.getMaxCacheSize()) {
      return
    }

    const cachedImages = this._imageCache.values()

    // Cache size has been exceeded, create list of images sorted by timeStamp
    // So we can purge the least recently used image
    function compare(a, b) {
      if (a.timeStamp > b.timeStamp) {
        return -1
      }
      if (a.timeStamp < b.timeStamp) {
        return 1
      }

      return 0
    }
    cachedImages.sort(compare)

    // Remove images as necessary)
    while (this.getCacheSize() > this.getMaxCacheSize()) {
      const lastCachedImage = cachedImages[cachedImages.length - 1]
      const imageId = lastCachedImage.imageId

      this.removeImageLoadObject(imageId)

      triggerEvent(eventTarget, EVENTS.IMAGE_CACHE_IMAGE_REMOVED, { imageId })
    }

    //const cacheInfo = getCacheInfo();

    //triggerEvent(eventTarget, EVENTS.IMAGE_CACHE_FULL, cacheInfo);
  }

  /**
   * Puts a new image load object into the cache
   *
   * @param {string} imageId ImageId of the image loader
   * @param {Object} imageLoadObject The object that is loading or loaded the image
   * @returns {void}
   */
  public putImageLoadObject(imageId: string, imageLoadObject: ImageLoadObject) {
    if (imageId === undefined) {
      throw new Error('putImageLoadObject: imageId must not be undefined')
    }
    if (imageLoadObject.promise === undefined) {
      throw new Error(
        'putImageLoadObject: imageLoadObject.promise must not be undefined'
      )
    }
    if (
      Object.prototype.hasOwnProperty.call(this._imageCache, imageId) === true
    ) {
      throw new Error('putImageLoadObject: imageId already in cache')
    }
    if (
      imageLoadObject.cancelFn &&
      typeof imageLoadObject.cancelFn !== 'function'
    ) {
      throw new Error(
        'putImageLoadObject: imageLoadObject.cancelFn must be a function'
      )
    }

    const cachedImage: CachedImage = {
      loaded: false,
      imageId,
      sharedCacheKey: undefined, // The sharedCacheKey for this imageId.  undefined by default
      imageLoadObject,
      timeStamp: Date.now(),
      sizeInBytes: 0,
    }

    this._imageCache.set(imageId, cachedImage)

    imageLoadObject.promise.then(
      (image: Image) => {
        if (!this._imageCache.get(imageId)) {
          // If the image has been purged before being loaded, we stop here.
          console.warn(
            'The image was purged from the cache before it completed loading.'
          )
          return
        }

        cachedImage.loaded = true
        cachedImage.image = image

        if (image.sizeInBytes === undefined) {
          throw new Error(
            'putImageLoadObject: image.sizeInBytes must not be undefined'
          )
        }
        if (image.sizeInBytes.toFixed === undefined) {
          throw new Error(
            'putImageLoadObject: image.sizeInBytes is not a number'
          )
        }

        cachedImage.sizeInBytes = image.sizeInBytes
        this._incrementCacheSize(cachedImage.sizeInBytes)

        const eventDetails = {
          image: cachedImage,
        }

        triggerEvent(eventTarget, EVENTS.IMAGE_CACHE_IMAGE_ADDED, eventDetails)

        cachedImage.sharedCacheKey = image.sharedCacheKey

        this._purgeCacheIfNecessary()
      },
      (error) => {
        console.warn(error)
        this._imageCache.delete(imageId)
      }
    )
  }

  /**
   * Retuns the object that is loading a given imageId
   *
   * @param {string} imageId Image ID
   * @returns {void}
   */
  public getImageLoadObject(imageId: string) {
    if (imageId === undefined) {
      throw new Error('getImageLoadObject: imageId must not be undefined')
    }
    const cachedImage = this._imageCache.get(imageId)

    if (cachedImage === undefined) {
      return
    }

    // Bump time stamp for cached image
    cachedImage.timeStamp = Date.now()

    return cachedImage.imageLoadObject
  }

  /**
   * Puts a new volume load object into the cache
   *
   * @param {string} volumeId Id of the Volume
   * @param {Object} volumeLoadObject
   * @returns {void}
   */
  public putVolumeLoadObject(
    volumeId: string,
    volumeLoadObject: VolumeLoadObject
  ) {
    if (volumeId === undefined) {
      throw new Error('putVolumeLoadObject: volumeId must not be undefined')
    }
    if (volumeLoadObject.promise === undefined) {
      throw new Error(
        'putVolumeLoadObject: volumeLoadObject.promise must not be undefined'
      )
    }
    if (
      Object.prototype.hasOwnProperty.call(this._volumeCache, volumeId) === true
    ) {
      throw new Error('putVolumeLoadObject: volumeId already in cache')
    }
    if (
      volumeLoadObject.cancelFn &&
      typeof volumeLoadObject.cancelFn !== 'function'
    ) {
      throw new Error(
        'putVolumeLoadObject: volumeLoadObject.cancelFn must be a function'
      )
    }

    const cachedVolume: CachedVolume = {
      loaded: false,
      volumeId,
      volumeLoadObject,
      timeStamp: Date.now(),
      sizeInBytes: 0,
    }

    this._volumeCache.set(volumeId, cachedVolume)

    volumeLoadObject.promise.then(
      (volume: Volume) => {
        if (!this._volumeCache.get(volumeId)) {
          // If the image has been purged before being loaded, we stop here.
          console.warn(
            'The image was purged from the cache before it completed loading.'
          )
          return
        }

        cachedVolume.loaded = true
        cachedVolume.volume = volume

        if (volume.sizeInBytes === undefined) {
          throw new Error(
            'putVolumeLoadObject: volume.sizeInBytes must not be undefined'
          )
        }
        if (volume.sizeInBytes.toFixed === undefined) {
          throw new Error(
            'putVolumeLoadObject: volume.sizeInBytes is not a number'
          )
        }

        cachedVolume.sizeInBytes = volume.sizeInBytes
        this._incrementCacheSize(cachedVolume.sizeInBytes)

        const eventDetails = {
          volume: cachedVolume,
        }

        triggerEvent(eventTarget, EVENTS.IMAGE_CACHE_VOLUME_ADDED, eventDetails)

        this._purgeCacheIfNecessary()
      },
      (error) => {
        console.warn(error)
        this._volumeLoadObjects.delete(volumeId)
        this._volumeCache.delete(volumeId)
      }
    )
  }

  /**
   * Returns the object that is loading a given imageId
   *
   * @param {string} imageId Image ID
   * @returns {void}
   */
  public getVolumeLoadObject = (volumeId: string) => {
    if (volumeId === undefined) {
      throw new Error('getVolumeLoadObject: volumeId must not be undefined')
    }
    const cachedVolume = this._volumeCache.get(volumeId)

    if (cachedVolume === undefined) {
      return
    }

    // Bump time stamp for cached volume (not used for anything for now)
    cachedVolume.timeStamp = Date.now()

    return cachedVolume.volumeLoadObject
  }

  /**
   *
   *
   * @param {string} imageId Image ID
   * @returns {void}
   */
  public getVolume = (volumeId: string) => {
    if (volumeId === undefined) {
      throw new Error('getVolume: volumeId must not be undefined')
    }
    const cachedVolume = this._volumeCache.get(volumeId)

    if (cachedVolume === undefined) {
      return
    }

    // Bump time stamp for cached volume (not used for anything for now)
    cachedVolume.timeStamp = Date.now()

    return cachedVolume.volume
  }

  /**
   * Removes the image loader associated with a given Id from the cache
   *
   * @param {string} imageId Image ID
   * @returns {void}
   */
  public removeImageLoadObject = (imageId: string) => {
    if (imageId === undefined) {
      throw new Error('removeImageLoadObject: imageId must not be undefined')
    }
    const cachedImage = this._imageCache.get(imageId)

    if (cachedImage === undefined) {
      throw new Error(
        'removeImageLoadObject: imageId was not present in imageCache'
      )
    }

    this._incrementCacheSize(-cachedImage.sizeInBytes)

    const eventDetails = {
      image: cachedImage,
    }

    triggerEvent(eventTarget, EVENTS.IMAGE_CACHE_IMAGE_REMOVED, eventDetails)
    this._decacheImage(imageId)
  }

  public removeVolumeLoadObject = (volumeId: string) => {
    if (volumeId === undefined) {
      throw new Error('removeVolumeLoadObject: volumeId must not be undefined')
    }
    const cachedVolume = this._volumeCache.get(volumeId)

    if (cachedVolume === undefined) {
      throw new Error(
        'removeVolumeLoadObject: volumeId was not present in volumeCache'
      )
    }

    this._incrementCacheSize(-cachedVolume.sizeInBytes)

    const eventDetails = {
      volume: cachedVolume,
    }

    triggerEvent(eventTarget, EVENTS.IMAGE_CACHE_VOLUME_REMOVED, eventDetails)
    this._decacheVolume(volumeId)
  }

  private _incrementCacheSize = (increment: number) => {
    this._cacheSize += increment
  }
}

export default new Cache()